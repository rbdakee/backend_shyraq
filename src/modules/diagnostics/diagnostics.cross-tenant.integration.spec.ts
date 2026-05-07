/**
 * B18 cross-tenant phantom-row integration spec — diagnostic_templates,
 * diagnostic_entries, and progress_notes tables.
 *
 * Seeds rows scoped to KG-A, then opens tenant-scoped TXs for KG-B and
 * asserts that all three tables return zero rows (RLS read isolation).
 * Also verifies that bypass_rls=true exposes KG-A rows and that
 * KG-B scope correctly returns its own rows.
 *
 * Self-skips when INTEGRATION_DB !== '1'.  Run with:
 *
 *   $env:DATABASE_PORT='55432'; $env:DATABASE_USERNAME='shyraq_app'
 *   $env:DATABASE_PASSWORD='shyraq_app'; $env:INTEGRATION_DB='1'
 *   npm test -- src/modules/diagnostics/diagnostics.cross-tenant.integration.spec.ts
 */
import 'reflect-metadata';
import { ExecutionContext } from '@nestjs/common';
import { defer, lastValueFrom } from 'rxjs';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { tenantStorage } from '@/database/tenant-storage';
import { TenantContextInterceptor } from '@/common/interceptors/tenant-context.interceptor';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

describeIntegration(
  'B18 diagnostic_templates + diagnostic_entries + progress_notes — cross-tenant phantom isolation (RLS)',
  () => {
    jest.setTimeout(60_000);

    let dataSource: DataSource;

    // KG identifiers
    let kgA: string;
    let kgB: string;

    // KG-A supporting rows
    let userA: string;
    let staffA: string;
    let userB: string;
    let staffB: string;
    let childA: string;
    let childB: string;

    // KG-A diagnostic rows (what we test isolation on)
    let templateA: string;
    let entryA: string;
    let noteA: string;

    // KG-B diagnostic rows (to verify KG-B scope returns only own rows)
    let templateB: string;
    let entryB: string;
    let noteB: string;

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
        entities: [],
        synchronize: false,
        logging: false,
      });
      await dataSource.initialize();

      // ── Seed all rows under bypass_rls ─────────────────────────────────────
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);

        kgA = randomUUID();
        kgB = randomUUID();
        userA = randomUUID();
        staffA = randomUUID();
        userB = randomUUID();
        staffB = randomUUID();
        childA = randomUUID();
        childB = randomUUID();
        templateA = randomUUID();
        entryA = randomUUID();
        noteA = randomUUID();
        templateB = randomUUID();
        entryB = randomUUID();
        noteB = randomUUID();

        // Kindergartens
        await m.query(
          `INSERT INTO kindergartens (id, name, slug) VALUES ($1, 'Diag KG-A', $2)`,
          [kgA, `diag-kg-a-${kgA.slice(0, 8)}`],
        );
        await m.query(
          `INSERT INTO kindergartens (id, name, slug) VALUES ($1, 'Diag KG-B', $2)`,
          [kgB, `diag-kg-b-${kgB.slice(0, 8)}`],
        );

        // Users + staff for each KG
        const phoneA = `+7700${kgA.replace(/-/g, '').slice(0, 7)}`;
        const phoneB = `+7701${kgB.replace(/-/g, '').slice(0, 7)}`;
        await m.query(
          `INSERT INTO users (id, phone, full_name) VALUES ($1, $2, 'Diag Admin A')`,
          [userA, phoneA],
        );
        await m.query(
          `INSERT INTO staff_members (id, kindergarten_id, user_id, role, is_active)
           VALUES ($1, $2, $3, 'specialist', true)`,
          [staffA, kgA, userA],
        );
        await m.query(
          `INSERT INTO users (id, phone, full_name) VALUES ($1, $2, 'Diag Admin B')`,
          [userB, phoneB],
        );
        await m.query(
          `INSERT INTO staff_members (id, kindergarten_id, user_id, role, is_active)
           VALUES ($1, $2, $3, 'specialist', true)`,
          [staffB, kgB, userB],
        );

        // Children (one per KG)
        await m.query(
          `INSERT INTO children (id, kindergarten_id, full_name, date_of_birth, status)
           VALUES ($1, $2, 'Diag Child A', '2021-01-01', 'card_created')`,
          [childA, kgA],
        );
        await m.query(
          `INSERT INTO children (id, kindergarten_id, full_name, date_of_birth, status)
           VALUES ($1, $2, 'Diag Child B', '2021-01-01', 'card_created')`,
          [childB, kgB],
        );

        // ── KG-A diagnostic data ──────────────────────────────────────────────

        // diagnostic_templates for KG-A
        await m.query(
          `INSERT INTO diagnostic_templates
             (id, kindergarten_id, specialist_type, name, version, is_active, schema, created_by)
           VALUES ($1, $2, 'psychologist', 'Template A', 1, true, '{"sections":[]}'::jsonb, $3)`,
          [templateA, kgA, staffA],
        );

        // diagnostic_entries for KG-A
        await m.query(
          `INSERT INTO diagnostic_entries
             (id, kindergarten_id, child_id, template_id, specialist_id, assessment_date, data)
           VALUES ($1, $2, $3, $4, $5, CURRENT_DATE, '{"score":5}'::jsonb)`,
          [entryA, kgA, childA, templateA, staffA],
        );

        // progress_notes for KG-A
        await m.query(
          `INSERT INTO progress_notes
             (id, kindergarten_id, child_id, mentor_id, body, noted_at)
           VALUES ($1, $2, $3, $4, 'Progress note A', now())`,
          [noteA, kgA, childA, staffA],
        );

        // ── KG-B diagnostic data ──────────────────────────────────────────────

        // diagnostic_templates for KG-B
        await m.query(
          `INSERT INTO diagnostic_templates
             (id, kindergarten_id, specialist_type, name, version, is_active, schema, created_by)
           VALUES ($1, $2, 'psychologist', 'Template B', 1, true, '{"sections":[]}'::jsonb, $3)`,
          [templateB, kgB, staffB],
        );

        // diagnostic_entries for KG-B
        await m.query(
          `INSERT INTO diagnostic_entries
             (id, kindergarten_id, child_id, template_id, specialist_id, assessment_date, data)
           VALUES ($1, $2, $3, $4, $5, CURRENT_DATE, '{"score":3}'::jsonb)`,
          [entryB, kgB, childB, templateB, staffB],
        );

        // progress_notes for KG-B
        await m.query(
          `INSERT INTO progress_notes
             (id, kindergarten_id, child_id, mentor_id, body, noted_at)
           VALUES ($1, $2, $3, $4, 'Progress note B', now())`,
          [noteB, kgB, childB, staffB],
        );
      });
    });

    afterAll(async () => {
      if (!dataSource?.isInitialized) return;
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(`DELETE FROM diagnostic_entries WHERE id IN ($1, $2)`, [
          entryA,
          entryB,
        ]);
        await m.query(`DELETE FROM progress_notes WHERE id IN ($1, $2)`, [
          noteA,
          noteB,
        ]);
        await m.query(`DELETE FROM diagnostic_templates WHERE id IN ($1, $2)`, [
          templateA,
          templateB,
        ]);
        await m.query(`DELETE FROM children WHERE id IN ($1, $2)`, [
          childA,
          childB,
        ]);
        await m.query(`DELETE FROM staff_members WHERE id IN ($1, $2)`, [
          staffA,
          staffB,
        ]);
        await m.query(`DELETE FROM users WHERE id IN ($1, $2)`, [userA, userB]);
        await m.query(`DELETE FROM kindergartens WHERE id IN ($1, $2)`, [
          kgA,
          kgB,
        ]);
      });
      await dataSource.destroy();
    });

    function makeCtx(req: Record<string, unknown>): ExecutionContext {
      return {
        getType: () => 'http',
        switchToHttp: () => ({ getRequest: () => req }),
      } as unknown as ExecutionContext;
    }

    /** Run a raw query inside a tenant-scoped TX via TenantContextInterceptor. */
    async function readRowsAs(
      kgId: string | null,
      bypass: boolean,
      sql: string,
      params: unknown[],
    ): Promise<Array<Record<string, unknown>>> {
      const interceptor = new TenantContextInterceptor(dataSource);
      const next = {
        handle: () =>
          defer(async () => {
            const ctx = tenantStorage.getStore();
            return ctx!.entityManager!.query(sql, params);
          }),
      };
      return (await lastValueFrom(
        interceptor.intercept(makeCtx({ tenant: { kgId, bypass } }), next),
      )) as Array<Record<string, unknown>>;
    }

    // ── Test block 1: KG-A scope returns only KG-A rows ──────────────────────

    it('diagnostic_templates: KG-A scope returns only KG-A row', async () => {
      const rows = await readRowsAs(
        kgA,
        false,
        `SELECT id FROM diagnostic_templates WHERE id IN ($1, $2)`,
        [templateA, templateB],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(templateA);
    });

    it('diagnostic_entries: KG-A scope returns only KG-A row', async () => {
      const rows = await readRowsAs(
        kgA,
        false,
        `SELECT id FROM diagnostic_entries WHERE id IN ($1, $2)`,
        [entryA, entryB],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(entryA);
    });

    it('progress_notes: KG-A scope returns only KG-A row', async () => {
      const rows = await readRowsAs(
        kgA,
        false,
        `SELECT id FROM progress_notes WHERE id IN ($1, $2)`,
        [noteA, noteB],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(noteA);
    });

    // ── Test block 2: KG-B scope returns only KG-B rows ──────────────────────

    it('diagnostic_templates: KG-B scope returns zero rows for KG-A data', async () => {
      const rows = await readRowsAs(
        kgB,
        false,
        `SELECT id FROM diagnostic_templates WHERE id = $1`,
        [templateA],
      );
      expect(rows).toHaveLength(0);
    });

    it('diagnostic_entries: KG-B scope returns zero rows for KG-A data', async () => {
      const rows = await readRowsAs(
        kgB,
        false,
        `SELECT id FROM diagnostic_entries WHERE id = $1`,
        [entryA],
      );
      expect(rows).toHaveLength(0);
    });

    it('progress_notes: KG-B scope returns zero rows for KG-A data', async () => {
      const rows = await readRowsAs(
        kgB,
        false,
        `SELECT id FROM progress_notes WHERE id = $1`,
        [noteA],
      );
      expect(rows).toHaveLength(0);
    });

    it('diagnostic_templates: KG-B scope returns only KG-B row', async () => {
      const rows = await readRowsAs(
        kgB,
        false,
        `SELECT id FROM diagnostic_templates WHERE id IN ($1, $2)`,
        [templateA, templateB],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(templateB);
    });

    it('diagnostic_entries: KG-B scope returns only KG-B row', async () => {
      const rows = await readRowsAs(
        kgB,
        false,
        `SELECT id FROM diagnostic_entries WHERE id IN ($1, $2)`,
        [entryA, entryB],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(entryB);
    });

    it('progress_notes: KG-B scope returns only KG-B row', async () => {
      const rows = await readRowsAs(
        kgB,
        false,
        `SELECT id FROM progress_notes WHERE id IN ($1, $2)`,
        [noteA, noteB],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(noteB);
    });

    // ── Test block 3: bypass_rls=true exposes rows from both KGs ─────────────

    it('bypass=true exposes diagnostic_templates rows from both KGs', async () => {
      const rows = await readRowsAs(
        null,
        true,
        `SELECT id FROM diagnostic_templates WHERE id IN ($1, $2)`,
        [templateA, templateB],
      );
      expect(rows).toHaveLength(2);
    });

    it('bypass=true exposes diagnostic_entries rows from both KGs', async () => {
      const rows = await readRowsAs(
        null,
        true,
        `SELECT id FROM diagnostic_entries WHERE id IN ($1, $2)`,
        [entryA, entryB],
      );
      expect(rows).toHaveLength(2);
    });

    it('bypass=true exposes progress_notes rows from both KGs', async () => {
      const rows = await readRowsAs(
        null,
        true,
        `SELECT id FROM progress_notes WHERE id IN ($1, $2)`,
        [noteA, noteB],
      );
      expect(rows).toHaveLength(2);
    });
  },
);
