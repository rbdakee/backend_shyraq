/**
 * B13 cross-tenant phantom-row integration spec — billing tables.
 *
 * For each of the 8 new billing tables, seeds a row scoped to KG-A, then
 * opens a tenant-scoped TX for KG-B and queries all 8 tables.  Every query
 * must return zero rows, proving FORCE ROW LEVEL SECURITY + tenant_isolation
 * policy are working correctly.
 *
 * Self-skips when INTEGRATION_DB !== '1'.  Run with:
 *
 *   $env:DATABASE_PORT='55432'; $env:DATABASE_USERNAME='shyraq_app'
 *   $env:DATABASE_PASSWORD='shyraq_app'; $env:INTEGRATION_DB='1'
 *   npm test -- --testPathPattern='billing.phantom'
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
  'B13 billing — cross-tenant phantom isolation (RLS)',
  () => {
    jest.setTimeout(60_000);

    let dataSource: DataSource;

    // Identifiers for KG-A seed data
    let kgA: string;
    let kgB: string;
    let userA: string;
    let staffA: string;
    let childA: string;
    let tariffPlanA: string;
    let tariffAssignmentA: string;
    let paymentAccountA: string;
    let invoiceA: string;
    let invoiceLineItemA: string;
    let paymentA: string;
    let refundA: string;
    let holidayA: string;

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
        tariffPlanA = randomUUID();
        tariffAssignmentA = randomUUID();
        paymentAccountA = randomUUID();
        invoiceA = randomUUID();
        invoiceLineItemA = randomUUID();
        paymentA = randomUUID();
        refundA = randomUUID();
        holidayA = randomUUID();

        // Kindergartens
        await m.query(
          `INSERT INTO kindergartens (id, name, slug) VALUES ($1, 'Billing KG-A', $2)`,
          [kgA, `billing-kg-a-${kgA.slice(0, 8)}`],
        );
        await m.query(
          `INSERT INTO kindergartens (id, name, slug) VALUES ($1, 'Billing KG-B', $2)`,
          [kgB, `billing-kg-b-${kgB.slice(0, 8)}`],
        );

        // User + staff for KG-A
        const phoneA = `+7700${kgA.replace(/-/g, '').slice(0, 7)}`;
        await m.query(
          `INSERT INTO users (id, phone, full_name) VALUES ($1, $2, 'Billing Admin A')`,
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
           VALUES ($1, $2, 'Billing Child A', '2021-01-01', 'card_created')`,
          [childA, kgA],
        );

        // tariff_plans
        await m.query(
          `INSERT INTO tariff_plans
             (id, kindergarten_id, name, tariff_type, amount, applies_to, valid_from)
           VALUES ($1, $2, 'Plan A', 'monthly', 50000, 'all_children', '2025-01-01')`,
          [tariffPlanA, kgA],
        );

        // tariff_assignments
        await m.query(
          `INSERT INTO tariff_assignments
             (id, kindergarten_id, child_id, tariff_plan_id, valid_from, assigned_by)
           VALUES ($1, $2, $3, $4, '2025-01-01', $5)`,
          [tariffAssignmentA, kgA, childA, tariffPlanA, staffA],
        );

        // payment_accounts
        await m.query(
          `INSERT INTO payment_accounts (id, kindergarten_id, child_id, balance)
           VALUES ($1, $2, $3, 0)`,
          [paymentAccountA, kgA, childA],
        );

        // invoices
        await m.query(
          `INSERT INTO invoices
             (id, kindergarten_id, child_id, payment_account_id, invoice_type,
              period_start, period_end, amount_due, amount_after_discount, status, due_date)
           VALUES ($1, $2, $3, $4, 'monthly',
                   '2025-01-01', '2025-01-31', 50000, 50000, 'pending', '2025-01-10')`,
          [invoiceA, kgA, childA, paymentAccountA],
        );

        // invoice_line_items
        await m.query(
          `INSERT INTO invoice_line_items
             (id, invoice_id, kindergarten_id, description, quantity, unit_price, line_total)
           VALUES ($1, $2, $3, 'Monthly fee', 1, 50000, 50000)`,
          [invoiceLineItemA, invoiceA, kgA],
        );

        // payments (no refund_id yet — circular FK is nullable)
        const idempotencyKey = `phantom-test-${paymentA}`;
        await m.query(
          `INSERT INTO payments
             (id, kindergarten_id, invoice_id, child_id, amount, provider, idempotency_key, status)
           VALUES ($1, $2, $3, $4, 50000, 'mock', $5, 'completed')`,
          [paymentA, kgA, invoiceA, childA, idempotencyKey],
        );

        // refunds
        await m.query(
          `INSERT INTO refunds
             (id, kindergarten_id, payment_id, amount, reason, status)
           VALUES ($1, $2, $3, 50000, 'Test refund', 'pending')`,
          [refundA, kgA, paymentA],
        );

        // kindergarten_holidays
        await m.query(
          `INSERT INTO kindergarten_holidays
             (id, kindergarten_id, date, name, is_billable)
           VALUES ($1, $2, '2025-01-01', '{"ru":"Новый год","kz":"Жаңа жыл"}', false)`,
          [holidayA, kgA],
        );
      });
    });

    afterAll(async () => {
      if (!dataSource?.isInitialized) return;
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(`DELETE FROM refunds        WHERE id = $1`, [refundA]);
        await m.query(`DELETE FROM payments       WHERE id = $1`, [paymentA]);
        await m.query(`DELETE FROM invoice_line_items WHERE id = $1`, [
          invoiceLineItemA,
        ]);
        await m.query(`DELETE FROM invoices       WHERE id = $1`, [invoiceA]);
        await m.query(`DELETE FROM payment_accounts WHERE id = $1`, [
          paymentAccountA,
        ]);
        await m.query(`DELETE FROM tariff_assignments WHERE id = $1`, [
          tariffAssignmentA,
        ]);
        await m.query(`DELETE FROM tariff_plans   WHERE id = $1`, [
          tariffPlanA,
        ]);
        await m.query(`DELETE FROM kindergarten_holidays WHERE id = $1`, [
          holidayA,
        ]);
        await m.query(`DELETE FROM children       WHERE id = $1`, [childA]);
        await m.query(`DELETE FROM staff_members  WHERE id = $1`, [staffA]);
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

    it('tariff_plans: KG-B scope returns zero rows for KG-A data', async () => {
      const rows = await readRowsAsKgB(
        `SELECT id FROM tariff_plans WHERE id = $1`,
        [tariffPlanA],
      );
      expect(rows).toHaveLength(0);
    });

    it('tariff_assignments: KG-B scope returns zero rows for KG-A data', async () => {
      const rows = await readRowsAsKgB(
        `SELECT id FROM tariff_assignments WHERE id = $1`,
        [tariffAssignmentA],
      );
      expect(rows).toHaveLength(0);
    });

    it('payment_accounts: KG-B scope returns zero rows for KG-A data', async () => {
      const rows = await readRowsAsKgB(
        `SELECT id FROM payment_accounts WHERE id = $1`,
        [paymentAccountA],
      );
      expect(rows).toHaveLength(0);
    });

    it('invoices: KG-B scope returns zero rows for KG-A data', async () => {
      const rows = await readRowsAsKgB(
        `SELECT id FROM invoices WHERE id = $1`,
        [invoiceA],
      );
      expect(rows).toHaveLength(0);
    });

    it('invoice_line_items: KG-B scope returns zero rows for KG-A data', async () => {
      const rows = await readRowsAsKgB(
        `SELECT id FROM invoice_line_items WHERE id = $1`,
        [invoiceLineItemA],
      );
      expect(rows).toHaveLength(0);
    });

    it('payments: KG-B scope returns zero rows for KG-A data', async () => {
      const rows = await readRowsAsKgB(
        `SELECT id FROM payments WHERE id = $1`,
        [paymentA],
      );
      expect(rows).toHaveLength(0);
    });

    it('refunds: KG-B scope returns zero rows for KG-A data', async () => {
      const rows = await readRowsAsKgB(`SELECT id FROM refunds WHERE id = $1`, [
        refundA,
      ]);
      expect(rows).toHaveLength(0);
    });

    it('kindergarten_holidays: KG-B scope returns zero rows for KG-A data', async () => {
      const rows = await readRowsAsKgB(
        `SELECT id FROM kindergarten_holidays WHERE id = $1`,
        [holidayA],
      );
      expect(rows).toHaveLength(0);
    });

    it('bypass=true exposes KG-A rows across all tables', async () => {
      // Sanity check: with bypass_rls=true, the seeded rows ARE visible.
      const interceptor = new TenantContextInterceptor(dataSource);
      const next = {
        handle: () =>
          defer(async () => {
            const ctx = tenantStorage.getStore();
            const mgr = ctx!.entityManager!;
            const [tp, ta, pa, inv, ili, pay, ref, kh] = await Promise.all([
              mgr.query(`SELECT id FROM tariff_plans       WHERE id = $1`, [
                tariffPlanA,
              ]),
              mgr.query(`SELECT id FROM tariff_assignments WHERE id = $1`, [
                tariffAssignmentA,
              ]),
              mgr.query(`SELECT id FROM payment_accounts   WHERE id = $1`, [
                paymentAccountA,
              ]),
              mgr.query(`SELECT id FROM invoices           WHERE id = $1`, [
                invoiceA,
              ]),
              mgr.query(`SELECT id FROM invoice_line_items WHERE id = $1`, [
                invoiceLineItemA,
              ]),
              mgr.query(`SELECT id FROM payments           WHERE id = $1`, [
                paymentA,
              ]),
              mgr.query(`SELECT id FROM refunds            WHERE id = $1`, [
                refundA,
              ]),
              mgr.query(`SELECT id FROM kindergarten_holidays WHERE id = $1`, [
                holidayA,
              ]),
            ]);
            return { tp, ta, pa, inv, ili, pay, ref, kh };
          }),
      };
      const result = (await lastValueFrom(
        interceptor.intercept(
          makeCtx({ tenant: { kgId: null, bypass: true } }),
          next,
        ),
      )) as Record<string, Array<unknown>>;

      expect(result.tp).toHaveLength(1);
      expect(result.ta).toHaveLength(1);
      expect(result.pa).toHaveLength(1);
      expect(result.inv).toHaveLength(1);
      expect(result.ili).toHaveLength(1);
      expect(result.pay).toHaveLength(1);
      expect(result.ref).toHaveLength(1);
      expect(result.kh).toHaveLength(1);
    });
  },
);
