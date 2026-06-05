/**
 * B24 cross-tenant phantom-row integration spec — kaspi_merchant_session.
 *
 * Proves that FORCE ROW LEVEL SECURITY + tenant_isolation policy on
 * `kaspi_merchant_session` correctly isolates tenants:
 *
 *   1. KG-A seeds one kaspi_merchant_session row.
 *   2. Under KG-B scope: SELECT returns 0 rows (phantom isolation).
 *   3. Under bypass_rls=true: SELECT returns the row (super-admin / poller path).
 *   4. WITH CHECK enforcement: INSERT with kindergarten_id=kg_B while
 *      GUC=kg_A is rejected by the policy.
 *
 * Self-skips when INTEGRATION_DB !== '1'.  Run with:
 *
 *   $env:DATABASE_PORT='55432'; $env:DATABASE_USERNAME='shyraq_app'
 *   $env:DATABASE_PASSWORD='shyraq_app'; $env:INTEGRATION_DB='1'
 *   npm test -- --testPathPattern='kaspi-merchant-session.cross-tenant'
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
  'B24 kaspi_merchant_session — cross-tenant phantom isolation (RLS)',
  () => {
    jest.setTimeout(60_000);

    let dataSource: DataSource;

    let kgA: string;
    let kgB: string;
    let userA: string;
    let sessionA: string;

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

      // ── Seed KG-A rows under bypass_rls ──────────────────────────────────
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);

        kgA = randomUUID();
        kgB = randomUUID();
        userA = randomUUID();
        sessionA = randomUUID();

        // Two kindergartens
        await m.query(
          `INSERT INTO kindergartens (id, name, slug) VALUES ($1, 'Kaspi KG-A', $2)`,
          [kgA, `kaspi-kg-a-${kgA.slice(0, 8)}`],
        );
        await m.query(
          `INSERT INTO kindergartens (id, name, slug) VALUES ($1, 'Kaspi KG-B', $2)`,
          [kgB, `kaspi-kg-b-${kgB.slice(0, 8)}`],
        );

        // Minimal user for connected_by_user_id FK
        const phoneA = `+7700${kgA.replace(/-/g, '').slice(0, 7)}`;
        await m.query(
          `INSERT INTO users (id, phone, full_name) VALUES ($1, $2, 'Kaspi Admin A')`,
          [userA, phoneA],
        );

        // One kaspi_merchant_session row for KG-A
        await m.query(
          `INSERT INTO kaspi_merchant_session
             (id, kindergarten_id, connected_by_user_id, status)
           VALUES ($1, $2, $3, 'pending')`,
          [sessionA, kgA, userA],
        );
      });
    });

    afterAll(async () => {
      if (!dataSource?.isInitialized) return;
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(`DELETE FROM kaspi_merchant_session WHERE id = $1`, [
          sessionA,
        ]);
        await m.query(`DELETE FROM users          WHERE id = $1`, [userA]);
        await m.query(`DELETE FROM kindergartens  WHERE id IN ($1, $2)`, [
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
      tenant: { kgId: string | null; bypass: boolean },
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
        interceptor.intercept(makeCtx({ tenant }), next),
      )) as Array<Record<string, unknown>>;
    }

    it('KG-B scope returns 0 rows for KG-A kaspi_merchant_session (phantom isolation)', async () => {
      const rows = await readRowsAs(
        { kgId: kgB, bypass: false },
        `SELECT id FROM kaspi_merchant_session WHERE id = $1`,
        [sessionA],
      );
      expect(rows).toHaveLength(0);
    });

    it('bypass_rls=true exposes KG-A row (super-admin / poller path)', async () => {
      const rows = await readRowsAs(
        { kgId: null, bypass: true },
        `SELECT id FROM kaspi_merchant_session WHERE id = $1`,
        [sessionA],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(sessionA);
    });

    it('KG-A scope sees its own kaspi_merchant_session row', async () => {
      const rows = await readRowsAs(
        { kgId: kgA, bypass: false },
        `SELECT id, kindergarten_id FROM kaspi_merchant_session WHERE id = $1`,
        [sessionA],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].kindergarten_id).toBe(kgA);
    });

    it('WITH CHECK rejects INSERT for kg_B when GUC is set to kg_A', async () => {
      // Attempt to INSERT a row whose kindergarten_id = kgB while the tenant
      // GUC is set to kgA — the policy WITH CHECK must reject it.
      const interceptor = new TenantContextInterceptor(dataSource);
      const newId = randomUUID();
      const next = {
        handle: () =>
          defer(async () => {
            const ctx = tenantStorage.getStore();
            // This INSERT violates the WITH CHECK clause:
            // kindergarten_id (kgB) ≠ current_setting('app.kindergarten_id') (kgA)
            return ctx!.entityManager!.query(
              `INSERT INTO kaspi_merchant_session
                 (id, kindergarten_id, connected_by_user_id, status)
               VALUES ($1, $2, $3, 'pending')`,
              [newId, kgB, userA],
            );
          }),
      };
      await expect(
        lastValueFrom(
          interceptor.intercept(
            makeCtx({ tenant: { kgId: kgA, bypass: false } }),
            next,
          ),
        ),
      ).rejects.toThrow();
    });
  },
);
