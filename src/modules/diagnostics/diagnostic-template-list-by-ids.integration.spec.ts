/**
 * B22b T5 / B18 M6 — batch template lookup integration spec.
 *
 * Drives `DiagnosticTemplateRelationalRepository.listByIds` against the
 * real Postgres (`INTEGRATION_DB=1`) so we pin the contract on actual
 * `WHERE id = ANY($2)` semantics + RLS scoping:
 *
 *   - Returns rows for in-tenant ids.
 *   - Drops cross-tenant ids (defence-in-depth confirmation; the calling
 *     service is supposed to pass `kgId` correctly, but RLS is the
 *     fallback if it doesn't).
 *   - Drops absent ids without raising.
 *   - Empty input → empty map, no query.
 *
 * Self-skips when `INTEGRATION_DB !== '1'`.
 *
 *   $env:DATABASE_PORT='55432'; $env:DATABASE_USERNAME='shyraq_app'
 *   $env:DATABASE_PASSWORD='shyraq_app'; $env:INTEGRATION_DB='1'
 *   npm test -- src/modules/diagnostics/diagnostic-template-list-by-ids.integration.spec.ts
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { tenantStorage } from '@/database/tenant-storage';
import { DiagnosticTemplateRelationalEntity } from './infrastructure/persistence/relational/entities/diagnostic-template.entity';
import { DiagnosticTemplateRelationalRepository } from './infrastructure/persistence/relational/repositories/diagnostic-template.relational-repository';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

describeIntegration(
  'B22b T5 — DiagnosticTemplateRelationalRepository.listByIds (batch, RLS-scoped)',
  () => {
    jest.setTimeout(60_000);

    let dataSource: DataSource;
    let repo: DiagnosticTemplateRelationalRepository;

    let kgA: string;
    let kgB: string;
    let userA: string;
    let staffA: string;
    let userB: string;
    let staffB: string;
    let templateA1: string;
    let templateA2: string;
    let templateB1: string;

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
        entities: [DiagnosticTemplateRelationalEntity],
        synchronize: false,
        logging: false,
      });
      await dataSource.initialize();

      const ormRepo = dataSource.getRepository(
        DiagnosticTemplateRelationalEntity,
      );
      repo = new DiagnosticTemplateRelationalRepository(ormRepo, dataSource);

      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);

        kgA = randomUUID();
        kgB = randomUUID();
        userA = randomUUID();
        staffA = randomUUID();
        userB = randomUUID();
        staffB = randomUUID();
        templateA1 = randomUUID();
        templateA2 = randomUUID();
        templateB1 = randomUUID();

        await m.query(
          `INSERT INTO kindergartens (id, name, slug) VALUES ($1, 'Batch KG-A', $2)`,
          [kgA, `batch-kg-a-${kgA.slice(0, 8)}`],
        );
        await m.query(
          `INSERT INTO kindergartens (id, name, slug) VALUES ($1, 'Batch KG-B', $2)`,
          [kgB, `batch-kg-b-${kgB.slice(0, 8)}`],
        );
        await m.query(
          `INSERT INTO users (id, phone, full_name)
           VALUES ($1, $2, 'Batch A'), ($3, $4, 'Batch B')`,
          [
            userA,
            `+7700${kgA.replace(/-/g, '').slice(0, 7)}`,
            userB,
            `+7701${kgB.replace(/-/g, '').slice(0, 7)}`,
          ],
        );
        await m.query(
          `INSERT INTO staff_members (id, kindergarten_id, user_id, role, is_active)
           VALUES ($1, $2, $3, 'specialist', true),
                  ($4, $5, $6, 'specialist', true)`,
          [staffA, kgA, userA, staffB, kgB, userB],
        );
        await m.query(
          `INSERT INTO diagnostic_templates
             (id, kindergarten_id, specialist_type, name, version, is_active, schema, created_by)
           VALUES
             ($1, $2, 'psychologist', 'Batch A1', 1, true, '{"sections":[{"title":"General","fields":[{"key":"score","label":"Score","type":"text","required":false}]}]}'::jsonb, $3),
             ($4, $5, 'psychologist', 'Batch A2', 1, true, '{"sections":[{"title":"General","fields":[{"key":"score","label":"Score","type":"text","required":false}]}]}'::jsonb, $6),
             ($7, $8, 'psychologist', 'Batch B1', 1, true, '{"sections":[{"title":"General","fields":[{"key":"score","label":"Score","type":"text","required":false}]}]}'::jsonb, $9)`,
          [
            templateA1,
            kgA,
            staffA,
            templateA2,
            kgA,
            staffA,
            templateB1,
            kgB,
            staffB,
          ],
        );
      });
    });

    afterAll(async () => {
      if (dataSource && dataSource.isInitialized) {
        await dataSource.transaction(async (m) => {
          await m.query(`SET LOCAL app.bypass_rls = 'true'`);
          await m.query(
            `DELETE FROM diagnostic_templates WHERE kindergarten_id IN ($1, $2)`,
            [kgA, kgB],
          );
          await m.query(
            `DELETE FROM staff_members WHERE kindergarten_id IN ($1, $2)`,
            [kgA, kgB],
          );
          await m.query(`DELETE FROM users WHERE id IN ($1, $2)`, [
            userA,
            userB,
          ]);
          await m.query(`DELETE FROM kindergartens WHERE id IN ($1, $2)`, [
            kgA,
            kgB,
          ]);
        });
        await dataSource.destroy();
      }
    });

    /** Helper — run a callback inside a tenant-scoped TX for `kgId`. */
    async function inTenant<T>(kgId: string, fn: () => Promise<T>): Promise<T> {
      return dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.kindergarten_id = '${kgId}'`);
        return tenantStorage.run({ kgId, bypass: false, entityManager: m }, fn);
      });
    }

    it('returns rows for in-tenant ids in a single query', async () => {
      const result = await inTenant(kgA, () =>
        repo.listByIds(kgA, [templateA1, templateA2]),
      );
      expect(result.size).toBe(2);
      expect(result.get(templateA1)?.name).toBe('Batch A1');
      expect(result.get(templateA2)?.name).toBe('Batch A2');
    });

    it('drops cross-tenant ids (RLS scope + WHERE kg_id clause)', async () => {
      // Asking KG-A for KG-B's template — must NOT leak.
      const result = await inTenant(kgA, () =>
        repo.listByIds(kgA, [templateA1, templateB1]),
      );
      expect(result.size).toBe(1);
      expect(result.has(templateA1)).toBe(true);
      expect(result.has(templateB1)).toBe(false);
    });

    it('drops absent ids without raising', async () => {
      const missing = randomUUID();
      const result = await inTenant(kgA, () =>
        repo.listByIds(kgA, [templateA1, missing]),
      );
      expect(result.size).toBe(1);
      expect(result.has(templateA1)).toBe(true);
      expect(result.has(missing)).toBe(false);
    });

    it('returns empty map for empty input', async () => {
      const result = await inTenant(kgA, () => repo.listByIds(kgA, []));
      expect(result.size).toBe(0);
    });

    it('handles duplicate ids by deduplicating in the result', async () => {
      // PG's `ANY($1::uuid[])` handles dup ids fine — the returned map
      // is keyed by template.id so duplicates collapse.
      const result = await inTenant(kgA, () =>
        repo.listByIds(kgA, [templateA1, templateA1, templateA2]),
      );
      expect(result.size).toBe(2);
    });
  },
);
