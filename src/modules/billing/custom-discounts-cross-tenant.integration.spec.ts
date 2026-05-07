/**
 * B16 cross-tenant phantom-row integration spec — custom_discounts +
 * custom_discount_applications tables.
 *
 * Seeds rows scoped to KG-A, then opens tenant-scoped TXs for KG-B and
 * asserts that:
 *   1. SELECT returns 0 rows (RLS read isolation).
 *   2. UPDATE affects 0 rows (RLS write isolation).
 *   3. cross-table: custom_discount_applications seeded in KG-A invisible
 *      from KG-B context.
 *   4. bypass_rls=true context sees both KG-A rows.
 *
 * Self-skips when INTEGRATION_DB !== '1'.  Run with:
 *
 *   $env:DATABASE_PORT='55432'; $env:DATABASE_USERNAME='shyraq_app'
 *   $env:DATABASE_PASSWORD='shyraq_app'; $env:INTEGRATION_DB='1'
 *   npm test -- --testPathPattern=custom-discounts-cross-tenant
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
  'B16 custom_discounts + applications — cross-tenant phantom isolation (RLS)',
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
    let paymentAccountA: string;
    let invoiceA: string;
    let invoiceLineItemA: string;

    // KG-A discount rows (the ones we test isolation on)
    let discountA: string;
    let applicationA: string;

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

      // ── Seed KG-A rows (all under bypass_rls) ─────────────────────────────
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);

        kgA = randomUUID();
        kgB = randomUUID();
        userA = randomUUID();
        staffA = randomUUID();
        childA = randomUUID();
        paymentAccountA = randomUUID();
        invoiceA = randomUUID();
        invoiceLineItemA = randomUUID();
        discountA = randomUUID();
        applicationA = randomUUID();

        // Kindergartens
        await m.query(
          `INSERT INTO kindergartens (id, name, slug) VALUES ($1, 'Discount KG-A', $2)`,
          [kgA, `discount-kg-a-${kgA.slice(0, 8)}`],
        );
        await m.query(
          `INSERT INTO kindergartens (id, name, slug) VALUES ($1, 'Discount KG-B', $2)`,
          [kgB, `discount-kg-b-${kgB.slice(0, 8)}`],
        );

        // User + staff for KG-A
        const phoneA = `+7700${kgA.replace(/-/g, '').slice(0, 7)}`;
        await m.query(
          `INSERT INTO users (id, phone, full_name) VALUES ($1, $2, 'Discount Admin A')`,
          [userA, phoneA],
        );
        await m.query(
          `INSERT INTO staff_members (id, kindergarten_id, user_id, role, is_active)
           VALUES ($1, $2, $3, 'admin', true)`,
          [staffA, kgA, userA],
        );

        // Child in KG-A
        await m.query(
          `INSERT INTO children (id, kindergarten_id, full_name, date_of_birth, status)
           VALUES ($1, $2, 'Discount Child A', '2021-01-01', 'card_created')`,
          [childA, kgA],
        );

        // payment_account + invoice + invoice_line_item (needed for applications FK)
        await m.query(
          `INSERT INTO payment_accounts (id, kindergarten_id, child_id, balance)
           VALUES ($1, $2, $3, 0)`,
          [paymentAccountA, kgA, childA],
        );
        await m.query(
          `INSERT INTO invoices
             (id, kindergarten_id, child_id, payment_account_id, invoice_type,
              period_start, period_end, amount_due, amount_after_discount, status, due_date)
           VALUES ($1, $2, $3, $4, 'monthly',
                   '2025-01-01', '2025-01-31', 50000, 45000, 'pending', '2025-01-10')`,
          [invoiceA, kgA, childA, paymentAccountA],
        );
        await m.query(
          `INSERT INTO invoice_line_items
             (id, invoice_id, kindergarten_id, description, quantity, unit_price, line_total)
           VALUES ($1, $2, $3, 'Monthly fee', 1, 50000, 50000)`,
          [invoiceLineItemA, invoiceA, kgA],
        );

        // custom_discounts row in KG-A
        await m.query(
          `INSERT INTO custom_discounts
             (id, kindergarten_id, name, discount_type, amount, valid_from, status)
           VALUES ($1, $2, '{"ru":"Скидка А","kz":"Жеңілдік А"}', 'percentage', 10, '2025-01-01', 'active')`,
          [discountA, kgA],
        );

        // custom_discount_applications row in KG-A
        await m.query(
          `INSERT INTO custom_discount_applications
             (id, kindergarten_id, custom_discount_id, invoice_id, invoice_line_item_id, child_id, amount_applied)
           VALUES ($1, $2, $3, $4, $5, $6, 5000)`,
          [applicationA, kgA, discountA, invoiceA, invoiceLineItemA, childA],
        );
      });
    });

    afterAll(async () => {
      if (!dataSource?.isInitialized) return;
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(
          `DELETE FROM custom_discount_applications WHERE id = $1`,
          [applicationA],
        );
        await m.query(`DELETE FROM custom_discounts WHERE id = $1`, [
          discountA,
        ]);
        await m.query(`DELETE FROM invoice_line_items WHERE id = $1`, [
          invoiceLineItemA,
        ]);
        await m.query(`DELETE FROM invoices WHERE id = $1`, [invoiceA]);
        await m.query(`DELETE FROM payment_accounts WHERE id = $1`, [
          paymentAccountA,
        ]);
        await m.query(`DELETE FROM children WHERE id = $1`, [childA]);
        await m.query(`DELETE FROM staff_members WHERE id = $1`, [staffA]);
        await m.query(`DELETE FROM users WHERE id = $1`, [userA]);
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

    // ── Test 1: RLS read isolation — custom_discounts ─────────────────────────

    it('custom_discounts: KG-B scope returns zero rows for KG-A data', async () => {
      const rows = await readRowsAsKgB(
        `SELECT id FROM custom_discounts WHERE id = $1`,
        [discountA],
      );
      expect(rows).toHaveLength(0);
    });

    // ── Test 2: RLS write isolation — UPDATE on KG-A row from KG-B context ───

    it('custom_discounts: UPDATE from KG-B context does not affect KG-A row', async () => {
      // Attempt to bump used_count on the KG-A discount from a KG-B session.
      const interceptor = new TenantContextInterceptor(dataSource);
      let affectedRows = -1;

      const next = {
        handle: () =>
          defer(async () => {
            const ctx = tenantStorage.getStore();
            const result: [unknown[], number] =
              (await ctx!.entityManager!.query(
                `UPDATE custom_discounts SET used_count = used_count + 1 WHERE id = $1`,
                [discountA],
              )) as [unknown[], number];
            // pg driver returns [rows, rowCount] for UPDATE
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

      // Confirm the row is still unchanged via bypass context
      const rows = await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        return m.query(
          `SELECT used_count FROM custom_discounts WHERE id = $1`,
          [discountA],
        );
      });
      // pg returns numeric columns as strings via node-postgres
      const usedCount = (rows as Array<{ used_count: string | number }>)[0]
        ?.used_count;
      expect(String(usedCount)).toBe('0');
    });

    // ── Test 3: RLS read isolation — custom_discount_applications ─────────────

    it('custom_discount_applications: KG-B scope returns zero rows for KG-A data', async () => {
      const rows = await readRowsAsKgB(
        `SELECT id FROM custom_discount_applications WHERE id = $1`,
        [applicationA],
      );
      expect(rows).toHaveLength(0);
    });

    // ── Test 4: bypass_rls=true exposes KG-A rows ─────────────────────────────

    it('bypass=true exposes both custom_discounts and applications rows', async () => {
      const interceptor = new TenantContextInterceptor(dataSource);
      const next = {
        handle: () =>
          defer(async () => {
            const ctx = tenantStorage.getStore();
            const mgr = ctx!.entityManager!;
            const [discs, apps] = await Promise.all([
              mgr.query(`SELECT id FROM custom_discounts WHERE id = $1`, [
                discountA,
              ]),
              mgr.query(
                `SELECT id FROM custom_discount_applications WHERE id = $1`,
                [applicationA],
              ),
            ]);
            return { discs, apps };
          }),
      };
      const result = (await lastValueFrom(
        interceptor.intercept(
          makeCtx({ tenant: { kgId: null, bypass: true } }),
          next,
        ),
      )) as { discs: Array<unknown>; apps: Array<unknown> };

      expect(result.discs).toHaveLength(1);
      expect(result.apps).toHaveLength(1);
    });
  },
);
