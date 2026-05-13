/**
 * B22a T4 — Optimistic-lock race spec for the three diagnostics tables.
 *
 * Self-skips when `INTEGRATION_DB !== '1'`. Run with:
 *
 *   $env:DATABASE_PORT='55432'; $env:DATABASE_USERNAME='shyraq_app';
 *   $env:DATABASE_PASSWORD='shyraq_app'; $env:INTEGRATION_DB='1';
 *   npm test -- --testPathPatterns='diagnostics-optimistic-lock.race'
 *
 * Invariant under test: N concurrent PATCHes against the same aggregate
 * — each loaded from the same `row_version` snapshot — result in
 * EXACTLY one winner. Late writers receive `OptimisticLockError`
 * (HTTP 409 `optimistic_lock_conflict`). The final `row_version` in
 * the DB reflects exactly one bump (`baseline + 1`), regardless of how
 * many losers attempted.
 *
 * Realised through the conditional `WHERE row_version = $expected`
 * UPDATE in each repo's `update()` method (see SM3 + B18 T6-M4 fix in
 * `<table>.relational-repository.ts`).
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { OptimisticLockError } from '@/shared-kernel/domain/errors';
import { DiagnosticTemplateRelationalEntity } from './infrastructure/persistence/relational/entities/diagnostic-template.entity';
import { DiagnosticEntryRelationalEntity } from './infrastructure/persistence/relational/entities/diagnostic-entry.entity';
import { ProgressNoteRelationalEntity } from './infrastructure/persistence/relational/entities/progress-note.entity';
import { DiagnosticTemplateRelationalRepository } from './infrastructure/persistence/relational/repositories/diagnostic-template.relational-repository';
import { DiagnosticEntryRelationalRepository } from './infrastructure/persistence/relational/repositories/diagnostic-entry.relational-repository';
import { ProgressNoteRelationalRepository } from './infrastructure/persistence/relational/repositories/progress-note.relational-repository';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

describeIntegration(
  'B22a T4 — diagnostics optimistic-lock race protection',
  () => {
    jest.setTimeout(60_000);

    let dataSource: DataSource;

    beforeAll(async () => {
      dataSource = new DataSource({
        type: 'postgres',
        host: process.env.DATABASE_HOST ?? 'localhost',
        port: process.env.DATABASE_PORT
          ? parseInt(process.env.DATABASE_PORT, 10)
          : 5432,
        username: process.env.DATABASE_USERNAME ?? 'shyraq_app',
        password: process.env.DATABASE_PASSWORD ?? 'shyraq_app',
        database: process.env.DATABASE_NAME ?? 'shyraq',
        entities: [
          DiagnosticTemplateRelationalEntity,
          DiagnosticEntryRelationalEntity,
          ProgressNoteRelationalEntity,
        ],
        synchronize: false,
        logging: false,
        poolSize: 20,
      });
      await dataSource.initialize();
    });

    afterAll(async () => {
      if (!dataSource?.isInitialized) return;
      await dataSource.destroy();
    });

    // ── shared seed helpers ──────────────────────────────────────────────────

    async function seedKgWithStaffAndChild(): Promise<{
      kgId: string;
      staffId: string;
      childId: string;
      cleanup: () => Promise<void>;
    }> {
      const kgId = randomUUID();
      const userId = randomUUID();
      const staffId = randomUUID();
      const childId = randomUUID();
      const slug = `oplock-${kgId.slice(0, 8)}`;

      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(
          `INSERT INTO kindergartens (id, name, slug) VALUES ($1, 'Optimistic Lock KG', $2)`,
          [kgId, slug],
        );
        await m.query(
          `INSERT INTO users (id, phone, full_name) VALUES ($1, $2, '')`,
          [userId, `+7702${kgId.slice(0, 7).replace(/-/g, '')}`.slice(0, 12)],
        );
        await m.query(
          `INSERT INTO staff_members
             (id, kindergarten_id, user_id, role, specialist_type, is_active)
           VALUES ($1, $2, $3, 'specialist', 'psychologist', true)`,
          [staffId, kgId, userId],
        );
        await m.query(
          `INSERT INTO children
             (id, kindergarten_id, full_name, date_of_birth, status)
           VALUES ($1, $2, 'Race Test Child', '2020-06-15', 'active')`,
          [childId, kgId],
        );
      });

      return {
        kgId,
        staffId,
        childId,
        cleanup: async () => {
          await dataSource.transaction(async (m) => {
            await m.query(`SET LOCAL app.bypass_rls = 'true'`);
            await m.query(
              `DELETE FROM progress_notes WHERE kindergarten_id = $1`,
              [kgId],
            );
            await m.query(
              `DELETE FROM diagnostic_entries WHERE kindergarten_id = $1`,
              [kgId],
            );
            await m.query(
              `DELETE FROM diagnostic_templates WHERE kindergarten_id = $1`,
              [kgId],
            );
            await m.query(`DELETE FROM children WHERE kindergarten_id = $1`, [
              kgId,
            ]);
            await m.query(
              `DELETE FROM staff_members WHERE kindergarten_id = $1`,
              [kgId],
            );
            await m.query(`DELETE FROM users WHERE id = $1`, [userId]);
            await m.query(`DELETE FROM kindergartens WHERE id = $1`, [kgId]);
          });
        },
      };
    }

    // ── DIAGNOSTIC TEMPLATE ─────────────────────────────────────────────────

    it('diagnostic_templates: 2 concurrent PATCHes — 1 winner + 1 OptimisticLockError; row_version === 2', async () => {
      const seed = await seedKgWithStaffAndChild();
      try {
        const templateId = randomUUID();
        const schema = {
          sections: [
            {
              title: 'Race',
              fields: [
                { key: 'note', label: 'Note', type: 'text', required: true },
              ],
            },
          ],
        };

        // Seed the template at row_version=1.
        await dataSource.transaction(async (m) => {
          await m.query(`SET LOCAL app.bypass_rls = 'true'`);
          await m.query(
            `INSERT INTO diagnostic_templates
               (id, kindergarten_id, specialist_type, name, description, version,
                row_version, is_active, schema, created_by, created_at, updated_at)
             VALUES ($1, $2, 'psychologist', 'Race', null, 1, 1, true, $3::jsonb,
                     $4, now(), now())`,
            [templateId, seed.kgId, JSON.stringify(schema), seed.staffId],
          );
        });

        // Both writers loaded the row at row_version=1 and try to PATCH.
        // We propagate the per-TX EntityManager + bypass_rls through
        // `tenantStorage.run` so the relational repo's `manager()`
        // helper picks up THIS transaction (and not a fresh pool
        // connection that would miss our SET LOCAL bypass_rls).
        const runUpdate = async (newName: string): Promise<'ok' | 'lock'> => {
          return dataSource.transaction(async (m) => {
            await m.query(`SET LOCAL app.bypass_rls = 'true'`);
            return tenantStorage.run(
              { kgId: seed.kgId, bypass: true, entityManager: m },
              async () => {
                const repo = new DiagnosticTemplateRelationalRepository(
                  m.getRepository(DiagnosticTemplateRelationalEntity),
                  dataSource,
                );
                const loaded = await repo.findById(seed.kgId, templateId);
                expect(loaded).not.toBeNull();
                // Brief stagger so both concurrent runs enter the
                // conditional UPDATE window at roughly the same time.
                await new Promise((r) => setTimeout(r, 30));
                const next = loaded!.update({ name: newName }, new Date());
                try {
                  await repo.update(next, loaded!.rowVersion);
                  return 'ok' as const;
                } catch (e) {
                  if (e instanceof OptimisticLockError) return 'lock' as const;
                  throw e;
                }
              },
            );
          });
        };

        const results = await Promise.all([runUpdate('A'), runUpdate('B')]);
        const winners = results.filter((r) => r === 'ok').length;
        const losers = results.filter((r) => r === 'lock').length;
        expect(winners).toBe(1);
        expect(losers).toBe(1);

        // Final row_version must reflect exactly one bump.
        await dataSource.transaction(async (m) => {
          await m.query(`SET LOCAL app.bypass_rls = 'true'`);
          const rows = (await m.query(
            `SELECT row_version FROM diagnostic_templates WHERE id = $1`,
            [templateId],
          )) as Array<{ row_version: number }>;
          expect(Number(rows[0].row_version)).toBe(2);
        });
      } finally {
        await seed.cleanup();
      }
    });

    // ── DIAGNOSTIC ENTRY ────────────────────────────────────────────────────

    it('diagnostic_entries: 2 concurrent PATCHes — 1 winner + 1 OptimisticLockError; row_version === 2', async () => {
      const seed = await seedKgWithStaffAndChild();
      try {
        const templateId = randomUUID();
        const entryId = randomUUID();
        const schema = {
          sections: [
            {
              title: 'Race',
              fields: [
                { key: 'note', label: 'Note', type: 'text', required: true },
              ],
            },
          ],
        };

        await dataSource.transaction(async (m) => {
          await m.query(`SET LOCAL app.bypass_rls = 'true'`);
          await m.query(
            `INSERT INTO diagnostic_templates
               (id, kindergarten_id, specialist_type, name, description, version,
                row_version, is_active, schema, created_by, created_at, updated_at)
             VALUES ($1, $2, 'psychologist', 'Race', null, 1, 1, true, $3::jsonb,
                     $4, now(), now())`,
            [templateId, seed.kgId, JSON.stringify(schema), seed.staffId],
          );
          await m.query(
            `INSERT INTO diagnostic_entries
               (id, kindergarten_id, child_id, template_id, specialist_id,
                assessment_date, data, summary, recommendations, attachments,
                created_at, updated_at, row_version)
             VALUES ($1, $2, $3, $4, $5, CURRENT_DATE, $6::jsonb, null, null,
                     null, now(), now(), 1)`,
            [
              entryId,
              seed.kgId,
              seed.childId,
              templateId,
              seed.staffId,
              JSON.stringify({ note: 'baseline' }),
            ],
          );
        });

        const runUpdate = async (
          newSummary: string,
        ): Promise<'ok' | 'lock'> => {
          return dataSource.transaction(async (m) => {
            await m.query(`SET LOCAL app.bypass_rls = 'true'`);
            return tenantStorage.run(
              { kgId: seed.kgId, bypass: true, entityManager: m },
              async () => {
                const repo = new DiagnosticEntryRelationalRepository(
                  m.getRepository(DiagnosticEntryRelationalEntity),
                  dataSource,
                );
                const loaded = await repo.findById(seed.kgId, entryId);
                expect(loaded).not.toBeNull();
                await new Promise((r) => setTimeout(r, 30));
                const next = loaded!.update(
                  { summary: newSummary },
                  new Date(),
                );
                try {
                  await repo.update(next, loaded!.rowVersion);
                  return 'ok' as const;
                } catch (e) {
                  if (e instanceof OptimisticLockError) return 'lock' as const;
                  throw e;
                }
              },
            );
          });
        };

        const results = await Promise.all([
          runUpdate('first'),
          runUpdate('second'),
        ]);
        expect(results.filter((r) => r === 'ok').length).toBe(1);
        expect(results.filter((r) => r === 'lock').length).toBe(1);

        await dataSource.transaction(async (m) => {
          await m.query(`SET LOCAL app.bypass_rls = 'true'`);
          const rows = (await m.query(
            `SELECT row_version FROM diagnostic_entries WHERE id = $1`,
            [entryId],
          )) as Array<{ row_version: number }>;
          expect(Number(rows[0].row_version)).toBe(2);
        });
      } finally {
        await seed.cleanup();
      }
    });

    // ── PROGRESS NOTE ───────────────────────────────────────────────────────

    it('progress_notes: 2 concurrent PATCHes — 1 winner + 1 OptimisticLockError; row_version === 2', async () => {
      const seed = await seedKgWithStaffAndChild();
      try {
        const noteId = randomUUID();
        // progress_notes mentor_id references staff_members; reuse the
        // seeded staff member as mentor for simplicity.
        await dataSource.transaction(async (m) => {
          await m.query(`SET LOCAL app.bypass_rls = 'true'`);
          await m.query(
            `INSERT INTO progress_notes
               (id, kindergarten_id, child_id, mentor_id, body, media_urls,
                noted_at, created_at, row_version)
             VALUES ($1, $2, $3, $4, 'baseline body', null, now(), now(), 1)`,
            [noteId, seed.kgId, seed.childId, seed.staffId],
          );
        });

        const runUpdate = async (newBody: string): Promise<'ok' | 'lock'> => {
          return dataSource.transaction(async (m) => {
            await m.query(`SET LOCAL app.bypass_rls = 'true'`);
            return tenantStorage.run(
              { kgId: seed.kgId, bypass: true, entityManager: m },
              async () => {
                const repo = new ProgressNoteRelationalRepository(
                  m.getRepository(ProgressNoteRelationalEntity),
                  dataSource,
                );
                const loaded = await repo.findById(seed.kgId, noteId);
                expect(loaded).not.toBeNull();
                await new Promise((r) => setTimeout(r, 30));
                const next = loaded!.update({ body: newBody }, new Date());
                try {
                  await repo.update(next, loaded!.rowVersion);
                  return 'ok' as const;
                } catch (e) {
                  if (e instanceof OptimisticLockError) return 'lock' as const;
                  throw e;
                }
              },
            );
          });
        };

        const results = await Promise.all([
          runUpdate('first'),
          runUpdate('second'),
        ]);
        expect(results.filter((r) => r === 'ok').length).toBe(1);
        expect(results.filter((r) => r === 'lock').length).toBe(1);

        await dataSource.transaction(async (m) => {
          await m.query(`SET LOCAL app.bypass_rls = 'true'`);
          const rows = (await m.query(
            `SELECT row_version FROM progress_notes WHERE id = $1`,
            [noteId],
          )) as Array<{ row_version: number }>;
          expect(Number(rows[0].row_version)).toBe(2);
        });
      } finally {
        await seed.cleanup();
      }
    });
  },
);
