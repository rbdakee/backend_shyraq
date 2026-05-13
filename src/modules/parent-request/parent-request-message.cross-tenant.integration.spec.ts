/**
 * F5-M2 cross-tenant phantom-row integration spec — parent_request_messages.
 *
 * Seeds a parent_request + parent_request_message row scoped to KG-A, then
 * opens tenant-scoped TXs for KG-B and asserts that:
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
 *   npx jest src/modules/parent-request/parent-request-message.cross-tenant.integration.spec.ts
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
  'F5-M2 parent_request_messages — cross-tenant phantom isolation (RLS)',
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

    // The parent_request and message rows we test isolation on
    let parentRequestA: string;
    let messageA: string;

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
        parentRequestA = randomUUID();
        messageA = randomUUID();

        // Kindergartens
        await m.query(
          `INSERT INTO kindergartens (id, name, slug) VALUES ($1, 'PRM KG-A', $2)`,
          [kgA, `prm-kg-a-${kgA.slice(0, 8)}`],
        );
        await m.query(
          `INSERT INTO kindergartens (id, name, slug) VALUES ($1, 'PRM KG-B', $2)`,
          [kgB, `prm-kg-b-${kgB.slice(0, 8)}`],
        );

        // User + staff member for KG-A
        const phoneA = `+7700${kgA.replace(/-/g, '').slice(0, 7)}`;
        await m.query(
          `INSERT INTO users (id, phone, full_name) VALUES ($1, $2, 'PRM User A')`,
          [userA, phoneA],
        );
        await m.query(
          `INSERT INTO staff_members (id, kindergarten_id, user_id, role, is_active)
           VALUES ($1, $2, $3, 'admin', true)`,
          [staffA, kgA, userA],
        );

        // Child in KG-A (required by parent_requests FK)
        await m.query(
          `INSERT INTO children
             (id, kindergarten_id, full_name, date_of_birth, status)
           VALUES ($1, $2, 'PRM Child A', '2021-03-15', 'active')`,
          [childA, kgA],
        );

        // parent_requests row in KG-A (open_request type, no date range)
        await m.query(
          `INSERT INTO parent_requests
             (id, kindergarten_id, child_id, requester_user_id, request_type, status)
           VALUES ($1, $2, $3, $4, 'open_request', 'pending')`,
          [parentRequestA, kgA, childA, userA],
        );

        // parent_request_messages row in KG-A
        // author_user_id is non-null, author_staff_id is null — satisfies XOR CHECK.
        await m.query(
          `INSERT INTO parent_request_messages
             (id, kindergarten_id, parent_request_id, author_user_id, author_staff_id, body)
           VALUES ($1, $2, $3, $4, NULL, 'Hello from KG-A')`,
          [messageA, kgA, parentRequestA, userA],
        );
      });
    });

    afterAll(async () => {
      if (!dataSource?.isInitialized) return;
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(`DELETE FROM parent_request_messages WHERE id = $1`, [
          messageA,
        ]);
        await m.query(`DELETE FROM parent_requests  WHERE id = $1`, [
          parentRequestA,
        ]);
        await m.query(`DELETE FROM children          WHERE id = $1`, [childA]);
        await m.query(`DELETE FROM staff_members     WHERE id = $1`, [staffA]);
        await m.query(`DELETE FROM users             WHERE id = $1`, [userA]);
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

    // ── Test 1: RLS read isolation — parent_request_messages ──────────────────

    it('parent_request_messages: KG-B scope returns zero rows for KG-A data', async () => {
      const rows = await readRowsAsKgB(
        `SELECT id FROM parent_request_messages WHERE id = $1`,
        [messageA],
      );
      expect(rows).toHaveLength(0);
    });

    // ── Test 2: RLS write isolation — UPDATE on KG-A message from KG-B ────────

    it('parent_request_messages: UPDATE from KG-B context does not affect KG-A row', async () => {
      const interceptor = new TenantContextInterceptor(dataSource);
      let affectedRows = -1;

      const next = {
        handle: () =>
          defer(async () => {
            const ctx = tenantStorage.getStore();
            // Attempt to modify body of a KG-A message from a KG-B session
            const result: [unknown[], number] =
              (await ctx!.entityManager!.query(
                `UPDATE parent_request_messages SET body = 'tampered' WHERE id = $1`,
                [messageA],
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

      // Confirm body is still original via bypass context
      const rows = await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        return m.query(
          `SELECT body FROM parent_request_messages WHERE id = $1`,
          [messageA],
        );
      });
      const body = (rows as Array<{ body: string }>)[0]?.body;
      expect(body).toBe('Hello from KG-A');
    });

    // ── Test 3: parent_requests also isolated from KG-B ───────────────────────

    it('parent_requests: KG-B scope returns zero rows for KG-A request', async () => {
      const rows = await readRowsAsKgB(
        `SELECT id FROM parent_requests WHERE id = $1`,
        [parentRequestA],
      );
      expect(rows).toHaveLength(0);
    });

    // ── Test 4: bypass_rls=true exposes the KG-A rows ─────────────────────────

    it('bypass=true exposes parent_request_messages and parent_requests KG-A rows', async () => {
      const interceptor = new TenantContextInterceptor(dataSource);
      const next = {
        handle: () =>
          defer(async () => {
            const ctx = tenantStorage.getStore();
            const msgs = await ctx!.entityManager!.query(
              `SELECT id FROM parent_request_messages WHERE id = $1`,
              [messageA],
            );
            const reqs = await ctx!.entityManager!.query(
              `SELECT id FROM parent_requests WHERE id = $1`,
              [parentRequestA],
            );
            return { msgs, reqs };
          }),
      };
      const result = (await lastValueFrom(
        interceptor.intercept(
          makeCtx({ tenant: { kgId: null, bypass: true } }),
          next,
        ),
      )) as { msgs: Array<{ id: string }>; reqs: Array<{ id: string }> };

      expect(result.msgs.find((r) => r.id === messageA)).toBeDefined();
      expect(result.reqs.find((r) => r.id === parentRequestA)).toBeDefined();
    });

    // ── Test 5: FORCE RLS — no GUC means zero rows ────────────────────────────

    it('parent_request_messages: query with no GUC set returns zero rows (FORCE RLS)', async () => {
      // shyraq_app is NOSUPERUSER NOBYPASSRLS — FORCE RLS applies.
      // Without setting app.kindergarten_id or app.bypass_rls, the policy
      // evaluates to false for every row.
      const rows = await dataSource.transaction(async (m) => {
        return m.query(`SELECT id FROM parent_request_messages WHERE id = $1`, [
          messageA,
        ]);
      });
      expect((rows as unknown[]).length).toBe(0);
    });
  },
);
