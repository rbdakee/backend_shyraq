/**
 * F5-M1 cross-tenant phantom-row integration spec — trusted_people.
 *
 * Seeds a trusted_person row scoped to KG-A, then opens tenant-scoped TXs for
 * KG-B and asserts that:
 *   1. SELECT returns 0 rows (RLS read isolation).
 *   2. UPDATE affects 0 rows (RLS write isolation).
 *   3. bypass_rls=true context sees the KG-A row.
 *   4. FORCE RLS: with no GUC set at all, SELECT must return 0 rows,
 *      confirming the FORCE clause is effective for the shyraq_app role
 *      (NOSUPERUSER NOBYPASSRLS).
 *
 * Self-skips when INTEGRATION_DB !== '1'. Run with:
 *
 *   $env:DATABASE_PORT='55432'; $env:DATABASE_USERNAME='shyraq_app'
 *   $env:DATABASE_PASSWORD='shyraq_app'; $env:INTEGRATION_DB='1'
 *   npx jest src/modules/pickup/trusted-person.cross-tenant.integration.spec.ts
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
  'F5-M1 trusted_people — cross-tenant phantom isolation (RLS)',
  () => {
    jest.setTimeout(60_000);

    let dataSource: DataSource;

    // KG identifiers
    let kgA: string;
    let kgB: string;

    // KG-A supporting rows
    let userA: string;
    let staffA: string;
    let childA: string;

    // The trusted_person row we test isolation on
    let trustedPersonA: string;

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

      // ── Seed KG-A rows (all under bypass_rls) ──────────────────────────────
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);

        kgA = randomUUID();
        kgB = randomUUID();
        userA = randomUUID();
        staffA = randomUUID();
        childA = randomUUID();
        trustedPersonA = randomUUID();

        // Kindergartens
        await m.query(
          `INSERT INTO kindergartens (id, name, slug) VALUES ($1, 'TP KG-A', $2)`,
          [kgA, `tp-kg-a-${kgA.slice(0, 8)}`],
        );
        await m.query(
          `INSERT INTO kindergartens (id, name, slug) VALUES ($1, 'TP KG-B', $2)`,
          [kgB, `tp-kg-b-${kgB.slice(0, 8)}`],
        );

        // User + staff member for KG-A (also acts as the trusted-person adder)
        const phoneA = `+7700${kgA.replace(/-/g, '').slice(0, 7)}`;
        await m.query(
          `INSERT INTO users (id, phone, full_name) VALUES ($1, $2, 'TP Staff A')`,
          [userA, phoneA],
        );
        await m.query(
          `INSERT INTO staff_members (id, kindergarten_id, user_id, role, is_active)
           VALUES ($1, $2, $3, 'admin', true)`,
          [staffA, kgA, userA],
        );

        // Child in KG-A
        await m.query(
          `INSERT INTO children
             (id, kindergarten_id, full_name, date_of_birth, status)
           VALUES ($1, $2, 'TP Child A', '2021-03-15', 'active')`,
          [childA, kgA],
        );

        // trusted_people row in KG-A
        await m.query(
          `INSERT INTO trusted_people
             (id, kindergarten_id, child_id, added_by_user_id,
              full_name, phone, relation, is_active, is_one_time)
           VALUES ($1, $2, $3, $4, 'Trusted Person A', '+77009990001', 'aunt', true, false)`,
          [trustedPersonA, kgA, childA, userA],
        );
      });
    });

    afterAll(async () => {
      if (!dataSource?.isInitialized) return;
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(`DELETE FROM trusted_people   WHERE id = $1`, [
          trustedPersonA,
        ]);
        await m.query(`DELETE FROM children         WHERE id = $1`, [childA]);
        await m.query(`DELETE FROM staff_members    WHERE id = $1`, [staffA]);
        await m.query(`DELETE FROM users            WHERE id = $1`, [userA]);
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

    /** Run a raw query inside a KG-B scoped tenant TX via TenantContextInterceptor. */
    async function readRowsAsKgB(
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
        interceptor.intercept(
          makeCtx({ tenant: { kgId: kgB, bypass: false } }),
          next,
        ),
      )) as Array<Record<string, unknown>>;
    }

    // ── Test 1: RLS read isolation ─────────────────────────────────────────────

    it('trusted_people: KG-B scope returns zero rows for KG-A data', async () => {
      const rows = await readRowsAsKgB(
        `SELECT id FROM trusted_people WHERE id = $1`,
        [trustedPersonA],
      );
      expect(rows).toHaveLength(0);
    });

    // ── Test 2: RLS write isolation ────────────────────────────────────────────

    it('trusted_people: UPDATE from KG-B context does not affect KG-A row', async () => {
      const interceptor = new TenantContextInterceptor(dataSource);
      let affectedRows = -1;

      const next = {
        handle: () =>
          defer(async () => {
            const ctx = tenantStorage.getStore();
            // Attempt to revoke the KG-A trusted person from a KG-B session
            const result: [unknown[], number] =
              (await ctx!.entityManager!.query(
                `UPDATE trusted_people SET is_active = false WHERE id = $1`,
                [trustedPersonA],
              )) as [unknown[], number];
            affectedRows = Array.isArray(result) ? (result[1] ?? 0) : 0;
            return affectedRows;
          }),
      };

      await lastValueFrom(
        interceptor.intercept(
          makeCtx({ tenant: { kgId: kgB, bypass: false } }),
          next,
        ),
      );

      // RLS must have blocked the UPDATE — 0 rows affected
      expect(affectedRows).toBe(0);

      // Confirm is_active is still true via bypass context
      const rows = await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        return m.query(`SELECT is_active FROM trusted_people WHERE id = $1`, [
          trustedPersonA,
        ]);
      });
      const isActive = (rows as Array<{ is_active: boolean }>)[0]?.is_active;
      expect(isActive).toBe(true);
    });

    // ── Test 3: bypass_rls=true exposes the KG-A row ──────────────────────────

    it('bypass=true exposes trusted_people KG-A row', async () => {
      const interceptor = new TenantContextInterceptor(dataSource);
      const next = {
        handle: () =>
          defer(async () => {
            const ctx = tenantStorage.getStore();
            return ctx!.entityManager!.query(
              `SELECT id FROM trusted_people WHERE id = $1`,
              [trustedPersonA],
            );
          }),
      };
      const rows = (await lastValueFrom(
        interceptor.intercept(
          makeCtx({ tenant: { kgId: null, bypass: true } }),
          next,
        ),
      )) as Array<{ id: string }>;
      expect(rows.find((r) => r.id === trustedPersonA)).toBeDefined();
    });

    // ── Test 4: FORCE RLS — no GUC means zero rows ────────────────────────────

    it('trusted_people: query with no GUC set returns zero rows (FORCE RLS)', async () => {
      // Connect directly via a raw transaction that deliberately omits any GUC.
      // shyraq_app is NOSUPERUSER NOBYPASSRLS so FORCE RLS applies.
      const rows = await dataSource.transaction(async (m) => {
        // Intentionally do NOT set app.kindergarten_id or app.bypass_rls.
        // The RLS policy `tenant_isolation` evaluates
        //   kindergarten_id = current_setting('app.kindergarten_id', true)::uuid
        // which returns NULL when the variable is unset (with the lenient
        // two-argument form), yielding NULL = uuid → false for all rows.
        return m.query(`SELECT id FROM trusted_people WHERE id = $1`, [
          trustedPersonA,
        ]);
      });
      expect((rows as unknown[]).length).toBe(0);
    });
  },
);
