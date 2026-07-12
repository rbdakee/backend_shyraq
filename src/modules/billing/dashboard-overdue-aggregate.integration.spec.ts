/**
 * B-DASH regression — dashboard overdue aggregates must NOT read false zeros
 * after the nightly pending/partial → overdue flip (markOverdueBatch) has run.
 *
 * Bug: `aggregateOverdue` and the `overdue` bucket of `aggregateByStatusBetween`
 * filtered `status IN ('pending','partial')`. Once markOverdueBatch flips a
 * past-due row to `status='overdue'`, that row dropped out of the aggregate —
 * so the dashboard "Просрочено" card read 0 while GET /admin/invoices?status=
 * overdue still listed the debt. Locked decision §0#4 says overdue is computed
 * by due_date, so the status set now spans every unpaid state
 * ('pending','partial','overdue'). This spec seeds one already-flipped
 * `overdue` row and proves it is counted.
 *
 * The DashboardService service-unit spec cannot catch this: its InvoiceRepository
 * fake returns canned values without touching SQL. Only a real-Postgres run
 * exercises the filter, hence an integration spec.
 *
 * Self-skips when INTEGRATION_DB !== '1'. Run with:
 *
 *   $env:DATABASE_PORT='55432'; $env:DATABASE_USERNAME='shyraq_app'
 *   $env:DATABASE_PASSWORD='shyraq_app'; $env:INTEGRATION_DB='1'
 *   npm test -- --testPathPattern='dashboard-overdue-aggregate'
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { tenantStorage } from '@/database/tenant-storage';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { InvoiceRelationalRepository } from './infrastructure/persistence/relational/repositories/invoice.relational.repository';
import { InvoiceTypeOrmEntity } from './infrastructure/persistence/relational/entities/invoice.typeorm.entity';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

// Asia/Almaty calendar day the aggregates are asked about. Chosen so every
// past-due seed row has due_date < TODAY and the one future row has
// due_date >= TODAY. Passed explicitly to the repo methods (they take `today`),
// so the assertions never depend on the wall clock.
const TODAY = '2026-07-12';
const PERIOD_FROM = '2026-06-01';
const PERIOD_TO = '2026-06-30';

describeIntegration(
  'B-DASH overdue aggregates — status=overdue rows count',
  () => {
    jest.setTimeout(60_000);

    let dataSource: DataSource;
    let repo: InvoiceRelationalRepository;

    let kg: string;
    let child: string;
    let paymentAccount: string;

    // One seed row per relevant (status, due_date) combination.
    const inv = {
      overdueFlipped: randomUUID(), // status='overdue', past-due — the regression row
      pendingPastDue: randomUUID(), // status='pending', past-due
      partialPastDue: randomUUID(), // status='partial', past-due
      pendingFuture: randomUUID(), // status='pending', not yet due → pending bucket
      paid: randomUUID(), // excluded from overdue
      cancelled: randomUUID(), // excluded everywhere
      refunded: randomUUID(), // refunded bucket only
    };

    // amount_after_discount per row (tenge). The overdue amount is dominated by
    // the flipped row so a regression (dropping it) is unmistakable.
    const AMT = {
      overdueFlipped: 2_000_000,
      pendingPastDue: 500_000,
      partialPastDue: 300_000,
      pendingFuture: 400_000,
      paid: 999_999,
      cancelled: 888_888,
      refunded: 77_777,
    };

    // Derived expectations.
    const OVERDUE_AMOUNT =
      AMT.overdueFlipped + AMT.pendingPastDue + AMT.partialPastDue; // 2_800_000

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
        entities: [InvoiceTypeOrmEntity],
        synchronize: false,
        logging: false,
      });
      await dataSource.initialize();
      repo = new InvoiceRelationalRepository(
        dataSource,
        dataSource.getRepository(InvoiceTypeOrmEntity),
      );

      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);

        kg = randomUUID();
        child = randomUUID();
        paymentAccount = randomUUID();

        await m.query(
          `INSERT INTO kindergartens (id, name, slug) VALUES ($1, 'DASH Overdue KG', $2)`,
          [kg, `dash-overdue-${kg.slice(0, 8)}`],
        );
        await m.query(
          `INSERT INTO children (id, kindergarten_id, full_name, date_of_birth, status)
         VALUES ($1, $2, 'DASH Overdue Child', '2021-01-01', 'active')`,
          [child, kg],
        );
        await m.query(
          `INSERT INTO payment_accounts (id, kindergarten_id, child_id, balance)
         VALUES ($1, $2, $3, 0)`,
          [paymentAccount, kg, child],
        );

        const seed = (
          id: string,
          status: string,
          dueDate: string,
          amount: number,
        ) =>
          m.query(
            `INSERT INTO invoices
             (id, kindergarten_id, child_id, payment_account_id, invoice_type,
              period_start, period_end, amount_due, amount_after_discount, status, due_date)
           VALUES ($1, $2, $3, $4, 'monthly', $5, $6, $7, $7, $8, $9)`,
            [
              id,
              kg,
              child,
              paymentAccount,
              PERIOD_FROM,
              PERIOD_TO,
              amount,
              status,
              dueDate,
            ],
          );

        await seed(
          inv.overdueFlipped,
          'overdue',
          '2026-06-10',
          AMT.overdueFlipped,
        );
        await seed(
          inv.pendingPastDue,
          'pending',
          '2026-06-15',
          AMT.pendingPastDue,
        );
        await seed(
          inv.partialPastDue,
          'partial',
          '2026-06-20',
          AMT.partialPastDue,
        );
        await seed(
          inv.pendingFuture,
          'pending',
          '2026-08-01',
          AMT.pendingFuture,
        );
        await seed(inv.paid, 'paid', '2026-06-01', AMT.paid);
        await seed(inv.cancelled, 'cancelled', '2026-06-01', AMT.cancelled);
        await seed(inv.refunded, 'refunded', '2026-06-01', AMT.refunded);
      });
    });

    afterAll(async () => {
      if (!dataSource?.isInitialized) return;
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(`DELETE FROM invoices WHERE kindergarten_id = $1`, [kg]);
        await m.query(`DELETE FROM payment_accounts WHERE id = $1`, [
          paymentAccount,
        ]);
        await m.query(`DELETE FROM children WHERE id = $1`, [child]);
        await m.query(`DELETE FROM kindergartens WHERE id = $1`, [kg]);
      });
      await dataSource.destroy();
    });

    /** Run `fn` inside a KG-scoped TX so the repo's `manager()` inherits the RLS GUC. */
    async function runAsKg<T>(fn: () => Promise<T>): Promise<T> {
      return dataSource.transaction(async (manager) => {
        await manager.query(`SET LOCAL app.kindergarten_id = '${kg}'`);
        const ctx: TenantContext = {
          kgId: kg,
          bypass: false,
          entityManager: manager,
        };
        return tenantStorage.run(ctx, fn);
      });
    }

    it('aggregateOverdue counts the already-flipped status=overdue row (no false zero)', async () => {
      const result = await runAsKg(() => repo.aggregateOverdue(kg, TODAY));

      // 3 past-due unpaid rows: overdue + pending + partial.
      expect(result.count).toBe(3);
      expect(result.amount).toBe(OVERDUE_AMOUNT); // 2_800_000
      // The whole point: dropping the status='overdue' row would give 800_000.
      expect(result.amount).toBeGreaterThan(
        AMT.pendingPastDue + AMT.partialPastDue,
      );
    });

    it('aggregateByStatusBetween overdue bucket includes status=overdue; pending stays date-gated', async () => {
      const buckets = await runAsKg(() =>
        repo.aggregateByStatusBetween(kg, PERIOD_FROM, PERIOD_TO, TODAY),
      );

      // overdue bucket = every unpaid row past its due_date.
      expect(buckets.overdue).toEqual({ count: 3, amount: OVERDUE_AMOUNT });
      // pending bucket = unpaid AND due_date >= today → only the future row.
      // The status='overdue' row is past-due, so it never leaks here.
      expect(buckets.pending).toEqual({ count: 1, amount: AMT.pendingFuture });
      expect(buckets.paid).toEqual({ count: 1, amount: AMT.paid });
      expect(buckets.refunded).toEqual({ count: 1, amount: AMT.refunded });
    });
  },
);
