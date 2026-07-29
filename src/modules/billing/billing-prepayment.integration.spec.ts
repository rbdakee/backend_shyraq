/**
 * Prepayment coverage — integration spec (PREPAYMENT_BILLING_FIX P1–P6).
 *
 * Self-skips when `INTEGRATION_DB !== '1'` so `npm test` stays green on
 * machines without a configured tenant DB. Run with:
 *
 *   INTEGRATION_DB=1 npx env-cmd -- npx jest billing-prepayment.integration --maxWorkers=1
 *
 * Three invariants against the real PG stack (real relational repositories,
 * real `InvoiceService` + `PaymentService` + `MonthlyBillingProcessor`; the
 * only fakes are the external ports — payment-provider adapter, fiscal
 * receipt, notification sink — never the DB):
 *
 *   1. Race, handoff §3.6: parent creates a 3-month prepayment (pending);
 *      the monthly cron for a covered month still bills the child (an
 *      UNPAID prepayment suppresses nothing, §2.7); when the prepayment
 *      settles through the real `PaymentService.processWebhook` path the
 *      overlapped pending monthly is auto-cancelled (§2.8 / P5). Replaying
 *      the same settlement is a no-op (no second cancel, no double account
 *      credit), and a repeat cron run for the same period creates nothing.
 *
 *   2. Cron suppression (§2.7 / P4): a PAID prepayment whose window covers
 *      the period makes `generateMonthly` skip that child while other
 *      children of the same kg are still billed — driven by ONE kg-wide
 *      `listChildIdsWithPaidPrepaymentCovering` query.
 *
 *   3. Cross-tenant phantom (CLAUDE.md §9.11): kg_A's paid prepayment
 *      neither suppresses kg_B's monthly generation for kg_B's own child
 *      nor leaks through `listChildIdsWithPaidPrepaymentCovering` under a
 *      kg_B tenant scope — including the explicit-kg_A-id-under-kg_B-RLS
 *      phantom read.
 *
 * Tenant context is published exactly the way production does it:
 * `MonthlyBillingProcessor.runForKindergarten` for cron runs, and a local
 * `inTenantTx` helper (same `set_config('app.kindergarten_id', …, true)` +
 * `tenantStorage.run` pattern) for direct service/repo calls.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { InMemoryNotificationAdapter } from '@/common/notifications/in-memory-notification.adapter';
import { tenantStorage } from '@/database/tenant-storage';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { TypeOrmTransactionRunnerAdapter } from '@/shared-kernel/infrastructure/adapters/typeorm-transaction-runner.adapter';
import { MockDiscountEngine } from './infrastructure/discount-engine/mock-discount-engine.adapter';
import { MockFiscalReceiptAdapter } from './infrastructure/fiscal-receipt/mock-fiscal-receipt.adapter';
import {
  CreatePaymentInput,
  CreatePaymentResult,
  PaymentProviderPort,
  RefundInput,
  RefundResult,
  VerifyWebhookInput,
  VerifyWebhookResult,
} from './infrastructure/payment-provider/payment-provider.port';
import { PaymentProviderRegistry } from './infrastructure/payment-provider/payment-provider.registry';
import { InvoiceRelationalRepository } from './infrastructure/persistence/relational/repositories/invoice.relational.repository';
import { InvoiceLineItemRelationalRepository } from './infrastructure/persistence/relational/repositories/invoice-line-item.relational.repository';
import { KindergartenHolidayRelationalRepository } from './infrastructure/persistence/relational/repositories/kindergarten-holiday.relational.repository';
import { PaymentAccountRelationalRepository } from './infrastructure/persistence/relational/repositories/payment-account.relational.repository';
import { PaymentRelationalRepository } from './infrastructure/persistence/relational/repositories/payment.relational.repository';
import { TariffAssignmentRelationalRepository } from './infrastructure/persistence/relational/repositories/tariff-assignment.relational.repository';
import { TariffPlanRelationalRepository } from './infrastructure/persistence/relational/repositories/tariff-plan.relational.repository';
import { InvoiceTypeOrmEntity } from './infrastructure/persistence/relational/entities/invoice.typeorm.entity';
import { InvoiceLineItemTypeOrmEntity } from './infrastructure/persistence/relational/entities/invoice-line-item.typeorm.entity';
import { KindergartenHolidayTypeOrmEntity } from './infrastructure/persistence/relational/entities/kindergarten-holiday.typeorm.entity';
import { PaymentAccountTypeOrmEntity } from './infrastructure/persistence/relational/entities/payment-account.typeorm.entity';
import { PaymentTypeOrmEntity } from './infrastructure/persistence/relational/entities/payment.typeorm.entity';
import { TariffAssignmentTypeOrmEntity } from './infrastructure/persistence/relational/entities/tariff-assignment.typeorm.entity';
import { TariffPlanTypeOrmEntity } from './infrastructure/persistence/relational/entities/tariff-plan.typeorm.entity';
import { HolidayService } from './holiday.service';
import { InvoiceService } from './invoice.service';
import { MonthlyBillingProcessor } from './monthly-billing.processor';
import { PaymentAccountService } from './payment-account.service';
import { PaymentService } from './payment.service';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

/**
 * 2026-06-15 in Asia/Almaty → prepayment window always starts 2026-07-01
 * (§2.1: first of NEXT month), so `JULY` below is the first covered month.
 */
const NOW = new Date('2026-06-15T09:00:00.000Z');
const JULY = new Date('2026-07-01T00:00:00.000Z');

/**
 * Seeded tariff: 50 000 KZT/month, `prepay_3m_pct=10`, zero holidays →
 * quote base 3 × 50 000 = 150 000, −10% = 135 000 whole tenge, three
 * per-month shares of 45 000 (largest-remainder split degenerates to an
 * even split on equal day-weights).
 */
const MONTHLY_AMOUNT = 50_000;
const PREPAY_TOTAL = 135_000;
const PREPAY_MONTH_SHARE = 45_000;

class FixedClock extends ClockPort {
  constructor(private readonly d: Date) {
    super();
  }
  now(): Date {
    return this.d;
  }
}

/**
 * Provider stub for the `mock` slot in `PaymentProviderRegistry`. Only
 * `verifyWebhook` is exercised — the specs seed the `payments` row directly
 * (status `processing`, `provider_txn_id` set) and settle it through the
 * real `PaymentService.processWebhook`, the same entry the production
 * webhook controller drives.
 */
class StubWebhookProvider extends PaymentProviderPort {
  verifyResult: VerifyWebhookResult | null = null;

  createPayment(_input: CreatePaymentInput): Promise<CreatePaymentResult> {
    return Promise.reject(new Error('createPayment not used in this spec'));
  }

  verifyWebhook(_input: VerifyWebhookInput): Promise<VerifyWebhookResult> {
    if (!this.verifyResult) {
      return Promise.reject(new Error('verifyResult not set'));
    }
    return Promise.resolve(this.verifyResult);
  }

  refund(_input: RefundInput): Promise<RefundResult> {
    return Promise.reject(new Error('refund not used in this spec'));
  }
}

describeIntegration(
  'Prepayment coverage — §3.6 settlement race + cron suppression + cross-tenant phantom',
  () => {
    jest.setTimeout(120_000);

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
          InvoiceTypeOrmEntity,
          InvoiceLineItemTypeOrmEntity,
          KindergartenHolidayTypeOrmEntity,
          PaymentAccountTypeOrmEntity,
          PaymentTypeOrmEntity,
          TariffAssignmentTypeOrmEntity,
          TariffPlanTypeOrmEntity,
        ],
        synchronize: false,
        logging: false,
        poolSize: 10,
      });
      await dataSource.initialize();
    });

    afterAll(async () => {
      if (!dataSource?.isInitialized) return;
      await dataSource.destroy();
    });

    /**
     * Real services wired against the live PG dataSource — mirrors
     * `billing.race.integration.spec.ts`'s `makeInvoiceService` and adds
     * the real `PaymentService` on top so settlement runs the production
     * `processWebhook → applyCompletedPayment → P5 hook` path. The B16
     * custom-discount deps are deliberately omitted (undefined-guard
     * short-circuit, same as the race spec); the discount engine is the
     * production default `MockDiscountEngine`, so `prepay_3m_pct` really
     * prices the quote.
     */
    function makeHarness() {
      const invoiceRepo = new InvoiceRelationalRepository(
        dataSource,
        dataSource.getRepository(InvoiceTypeOrmEntity),
      );
      const lineItemRepo = new InvoiceLineItemRelationalRepository(
        dataSource.getRepository(InvoiceLineItemTypeOrmEntity),
      );
      const tariffPlanRepo = new TariffPlanRelationalRepository(
        dataSource.getRepository(TariffPlanTypeOrmEntity),
      );
      const tariffAssignmentRepo = new TariffAssignmentRelationalRepository(
        dataSource.getRepository(TariffAssignmentTypeOrmEntity),
      );
      const paymentAccountRepo = new PaymentAccountRelationalRepository(
        dataSource.getRepository(PaymentAccountTypeOrmEntity),
      );
      const paymentRepo = new PaymentRelationalRepository(
        dataSource,
        dataSource.getRepository(PaymentTypeOrmEntity),
      );
      const holidayRepo = new KindergartenHolidayRelationalRepository(
        dataSource.getRepository(KindergartenHolidayTypeOrmEntity),
      );
      const clock = new FixedClock(NOW);
      const paymentAccountService = new PaymentAccountService(
        paymentAccountRepo,
        clock,
      );
      const holidayService = new HolidayService(holidayRepo, clock);
      const notifier = new InMemoryNotificationAdapter();
      const invoiceService = new InvoiceService(
        invoiceRepo,
        lineItemRepo,
        tariffPlanRepo,
        tariffAssignmentRepo,
        paymentAccountService,
        new MockDiscountEngine(),
        holidayService,
        notifier,
        clock,
        paymentRepo,
      );
      const provider = new StubWebhookProvider();
      const paymentService = new PaymentService(
        paymentRepo,
        invoiceRepo,
        invoiceService,
        paymentAccountService,
        new PaymentProviderRegistry(
          [{ provider: 'mock', adapter: provider }],
          ['mock'],
        ),
        new MockFiscalReceiptAdapter(),
        notifier,
        clock,
        new TypeOrmTransactionRunnerAdapter(dataSource),
      );
      const processor = new MonthlyBillingProcessor(
        invoiceService,
        dataSource,
        clock,
      );
      return {
        invoiceRepo,
        invoiceService,
        paymentService,
        processor,
        notifier,
        provider,
      };
    }

    /**
     * Run `fn` under a kg-scoped tenant TX — the exact context publishing
     * `MonthlyBillingProcessor.runForKindergarten` does (set_config with
     * is_local=true + tenantStorage), so repositories resolve the ambient
     * EntityManager and RLS filters rows for `kgId`.
     */
    async function inTenantTx<T>(
      kgId: string,
      fn: () => Promise<T>,
    ): Promise<T> {
      return dataSource.transaction(async (em) => {
        await em.query(`SELECT set_config('app.kindergarten_id', $1, true)`, [
          kgId,
        ]);
        return tenantStorage.run(
          { kgId, bypass: false, entityManager: em },
          fn,
        );
      });
    }

    /**
     * Seed one kindergarten with N children, each on the same 50 000 KZT
     * monthly plan carrying `prepay_3m_pct=10`. Payment accounts are
     * pre-created (same rationale as the race spec — keeps the orthogonal
     * findOrCreate unique-constraint race out of scope).
     */
    async function seedKindergarten(numChildren: number): Promise<{
      kgId: string;
      childIds: string[];
      accountIds: string[];
      planId: string;
      cleanup: () => Promise<void>;
    }> {
      const kgId = randomUUID();
      const userId = randomUUID();
      const staffId = randomUUID();
      const planId = randomUUID();
      const childIds: string[] = [];
      const accountIds: string[] = [];

      const slug = `prepay-billing-${kgId.slice(0, 8)}`;
      const phone = `+7700${kgId.replace(/-/g, '').slice(0, 7)}`;

      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(
          `INSERT INTO kindergartens (id, name, slug, is_active)
           VALUES ($1, 'Prepay Billing KG', $2, true)`,
          [kgId, slug],
        );
        await m.query(
          `INSERT INTO users (id, phone, full_name) VALUES ($1, $2, 'Prepay Admin')`,
          [userId, phone],
        );
        await m.query(
          `INSERT INTO staff_members (id, kindergarten_id, user_id, role, is_active)
           VALUES ($1, $2, $3, 'admin', true)`,
          [staffId, kgId, userId],
        );
        await m.query(
          `INSERT INTO tariff_plans
             (id, kindergarten_id, name, tariff_type, amount, applies_to, valid_from, discount_rules)
           VALUES ($1, $2, 'Prepay Plan', 'monthly', $3, 'all_children', '2025-01-01', $4::jsonb)`,
          [planId, kgId, MONTHLY_AMOUNT, JSON.stringify({ prepay_3m_pct: 10 })],
        );
        for (let i = 0; i < numChildren; i++) {
          const childId = randomUUID();
          const assignmentId = randomUUID();
          const accountId = randomUUID();
          childIds.push(childId);
          accountIds.push(accountId);
          await m.query(
            `INSERT INTO children (id, kindergarten_id, full_name, date_of_birth, status)
             VALUES ($1, $2, $3, '2021-01-01', 'card_created')`,
            [childId, kgId, `Prepay Child ${i + 1}`],
          );
          await m.query(
            `INSERT INTO tariff_assignments
               (id, kindergarten_id, child_id, tariff_plan_id, valid_from, assigned_by)
             VALUES ($1, $2, $3, $4, '2025-01-01', $5)`,
            [assignmentId, kgId, childId, planId, userId],
          );
          await m.query(
            `INSERT INTO payment_accounts (id, kindergarten_id, child_id, balance)
             VALUES ($1, $2, $3, 0)`,
            [accountId, kgId, childId],
          );
        }
      });

      const cleanup = async () => {
        await dataSource.transaction(async (m) => {
          await m.query(`SET LOCAL app.bypass_rls = 'true'`);
          await m.query(`DELETE FROM payments WHERE kindergarten_id = $1`, [
            kgId,
          ]);
          await m.query(
            `DELETE FROM invoice_line_items WHERE kindergarten_id = $1`,
            [kgId],
          );
          await m.query(`DELETE FROM invoices WHERE kindergarten_id = $1`, [
            kgId,
          ]);
          await m.query(
            `DELETE FROM payment_accounts WHERE kindergarten_id = $1`,
            [kgId],
          );
          await m.query(
            `DELETE FROM tariff_assignments WHERE kindergarten_id = $1`,
            [kgId],
          );
          await m.query(`DELETE FROM tariff_plans WHERE kindergarten_id = $1`, [
            kgId,
          ]);
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
      };

      return { kgId, childIds, accountIds, planId, cleanup };
    }

    // ── raw-SQL read/seed helpers (bypass_rls, own short TX) ──────────────

    interface InvoiceRow {
      id: string;
      child_id: string;
      invoice_type: string;
      status: string;
      period_start: string;
    }

    async function readMonthlies(kgId: string): Promise<InvoiceRow[]> {
      return dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        return (await m.query(
          `SELECT id, child_id, invoice_type, status, period_start::text AS period_start
             FROM invoices
            WHERE kindergarten_id = $1 AND invoice_type = 'monthly'
            ORDER BY period_start ASC, created_at ASC`,
          [kgId],
        )) as InvoiceRow[];
      });
    }

    async function readInvoiceStatus(invoiceId: string): Promise<string> {
      return dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        const rows = (await m.query(
          `SELECT status FROM invoices WHERE id = $1`,
          [invoiceId],
        )) as Array<{ status: string }>;
        return rows[0]?.status ?? '<missing>';
      });
    }

    async function readLineItems(
      invoiceId: string,
    ): Promise<
      Array<{ description: string; quantity: number; line_total: number }>
    > {
      return dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        return (await m.query(
          `SELECT description, quantity::float8 AS quantity, line_total::float8 AS line_total
             FROM invoice_line_items
            WHERE invoice_id = $1
            ORDER BY created_at ASC`,
          [invoiceId],
        )) as Array<{
          description: string;
          quantity: number;
          line_total: number;
        }>;
      });
    }

    async function readBalance(kgId: string, childId: string): Promise<number> {
      return dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        const rows = (await m.query(
          `SELECT balance::float8 AS balance
             FROM payment_accounts
            WHERE kindergarten_id = $1 AND child_id = $2`,
          [kgId, childId],
        )) as Array<{ balance: number }>;
        return rows[0]?.balance ?? NaN;
      });
    }

    /** Seed flip — pending → paid without a payment row (§2.7 seeding). */
    async function markInvoicePaidRaw(invoiceId: string): Promise<void> {
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(`UPDATE invoices SET status = 'paid' WHERE id = $1`, [
          invoiceId,
        ]);
      });
    }

    /**
     * Seed a `processing` payment carrying the full prepayment amount and a
     * known `provider_txn_id` — the row `processWebhook` resolves
     * cross-tenant and settles.
     */
    async function seedProcessingPayment(
      kgId: string,
      invoiceId: string,
      childId: string,
      amountKzt: number,
      providerTxnId: string,
    ): Promise<string> {
      const id = randomUUID();
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(
          `INSERT INTO payments
             (id, kindergarten_id, invoice_id, child_id, amount, provider,
              provider_txn_id, idempotency_key, status)
           VALUES ($1, $2, $3, $4, $5, 'mock', $6, $7, 'processing')`,
          [
            id,
            kgId,
            invoiceId,
            childId,
            amountKzt,
            providerTxnId,
            `prepay-int-${id}`,
          ],
        );
      });
      return id;
    }

    /**
     * Seed a bare pending monthly invoice (idempotency bait for the replay
     * step — a re-fired P5 hook WOULD cancel it).
     */
    async function seedPendingMonthly(
      kgId: string,
      childId: string,
      accountId: string,
      planId: string,
      periodStart: string,
      periodEnd: string,
    ): Promise<string> {
      const id = randomUUID();
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(
          `INSERT INTO invoices
             (id, kindergarten_id, child_id, payment_account_id, tariff_plan_id,
              invoice_type, period_start, period_end, amount_due,
              amount_after_discount, status, due_date)
           VALUES ($1, $2, $3, $4, $5, 'monthly', $6, $7, $8, $8, 'pending', $6)`,
          [
            id,
            kgId,
            childId,
            accountId,
            planId,
            periodStart,
            periodEnd,
            MONTHLY_AMOUNT,
          ],
        );
      });
      return id;
    }

    // ── Scenario 1: §3.6 race — create → cron bills → settle → auto-cancel ─

    it('cancels the cron-billed covered monthly when the prepayment settles, replays as a no-op, and generates nothing on a repeat cron run', async () => {
      const seed = await seedKindergarten(1);
      const [childId] = seed.childIds;
      try {
        const h = makeHarness();

        // Step 1 — no debt → prepayInvoice creates a PENDING prepayment_3m
        // for Jul–Sep at 135 000 (150 000 − 10%), one line item per month.
        const prepayment = await inTenantTx(seed.kgId, () =>
          h.invoiceService.prepayInvoice(seed.kgId, childId, 3),
        );
        expect(prepayment.status).toBe('pending');
        expect(prepayment.invoiceType).toBe('prepayment_3m');
        expect(prepayment.periodStart.toISOString().slice(0, 10)).toBe(
          '2026-07-01',
        );
        expect(prepayment.periodEnd.toISOString().slice(0, 10)).toBe(
          '2026-09-30',
        );
        expect(prepayment.amountAfterDiscount.toNumber()).toBe(PREPAY_TOTAL);

        const items = await readLineItems(prepayment.id);
        expect(items).toHaveLength(3);
        expect(items.map((li) => li.quantity)).toEqual([1, 1, 1]);
        expect(items.map((li) => li.line_total)).toEqual([
          PREPAY_MONTH_SHARE,
          PREPAY_MONTH_SHARE,
          PREPAY_MONTH_SHARE,
        ]);
        expect(items.map((li) => li.description.slice(0, 18))).toEqual([
          'Prepayment 2026-07',
          'Prepayment 2026-08',
          'Prepayment 2026-09',
        ]);

        // Step 2 — cron for July: the prepayment is UNPAID, so the child is
        // NOT suppressed and the covered month gets its monthly invoice.
        const run1 = await h.processor.runForKindergarten(seed.kgId, JULY);
        expect(run1).toEqual({ generated: 1, skipped: 0 });
        const monthliesAfterCron = await readMonthlies(seed.kgId);
        expect(monthliesAfterCron).toHaveLength(1);
        const julyMonthly = monthliesAfterCron[0];
        expect(julyMonthly.child_id).toBe(childId);
        expect(julyMonthly.status).toBe('pending');
        expect(julyMonthly.period_start).toBe('2026-07-01');

        // Step 3 — settle the prepayment through the REAL webhook path
        // (processWebhook → applyCompletedPayment → P5 hook). The overlapped
        // pending July monthly must end cancelled.
        const txnId = `mock-prepay-${randomUUID()}`;
        await seedProcessingPayment(
          seed.kgId,
          prepayment.id,
          childId,
          PREPAY_TOTAL,
          txnId,
        );
        h.provider.verifyResult = {
          providerPaymentId: txnId,
          status: 'completed',
          raw: { status: 'completed' },
        };
        const settled = await h.paymentService.processWebhook({
          provider: 'mock',
          headers: {},
          body: {},
        });
        expect(settled.status).toBe('completed');

        expect(await readInvoiceStatus(prepayment.id)).toBe('paid');
        expect(await readInvoiceStatus(julyMonthly.id)).toBe('cancelled');
        expect(await readBalance(seed.kgId, childId)).toBe(PREPAY_TOTAL);

        const cancelEvents = h.notifier.events.filter(
          (e) => e.type === 'invoice_cancelled',
        );
        expect(cancelEvents).toHaveLength(1);
        expect(cancelEvents[0].event).toMatchObject({
          invoiceId: julyMonthly.id,
          childId,
          reason: 'covered_by_prepayment',
        });

        // Step 4 — replay the SAME settlement. The early completed-payment
        // return must fire before the P5 hook: a fresh pending monthly
        // inside the window (bait) survives, the account is not credited a
        // second time, and no new cancel notification is emitted.
        const baitMonthlyId = await seedPendingMonthly(
          seed.kgId,
          childId,
          seed.accountIds[0],
          seed.planId,
          '2026-08-01',
          '2026-08-31',
        );
        const replayed = await h.paymentService.processWebhook({
          provider: 'mock',
          headers: {},
          body: {},
        });
        expect(replayed.status).toBe('completed');
        expect(await readInvoiceStatus(baitMonthlyId)).toBe('pending');
        expect(await readInvoiceStatus(prepayment.id)).toBe('paid');
        expect(await readInvoiceStatus(julyMonthly.id)).toBe('cancelled');
        expect(await readBalance(seed.kgId, childId)).toBe(PREPAY_TOTAL);
        expect(
          h.notifier.events.filter((e) => e.type === 'invoice_cancelled'),
        ).toHaveLength(1);

        // Step 5 — a second cron run for the same period creates nothing:
        // the July monthly row (even cancelled) arms the kg-wide
        // existsMonthlyForPeriod short-circuit.
        const run2 = await h.processor.runForKindergarten(seed.kgId, JULY);
        expect(run2.generated).toBe(0);
        const monthliesFinal = await readMonthlies(seed.kgId);
        expect(
          monthliesFinal.filter((r) => r.period_start === '2026-07-01'),
        ).toHaveLength(1);
        // Exactly the cancelled July row + the August bait — nothing new.
        expect(monthliesFinal).toHaveLength(2);
      } finally {
        await seed.cleanup();
      }
    });

    // ── Scenario 2: cron suppression by a PAID prepayment (§2.7 / P4) ─────

    it('skips only the child covered by a paid prepayment in generateMonthly while other children are still billed', async () => {
      const seed = await seedKindergarten(2);
      const [childA, childB] = seed.childIds;
      try {
        const h = makeHarness();

        const prepayment = await inTenantTx(seed.kgId, () =>
          h.invoiceService.prepayInvoice(seed.kgId, childA, 3),
        );
        await markInvoicePaidRaw(prepayment.id);

        // Kg-wide coverage query the cron consumes (tenant-scoped).
        const covered = await inTenantTx(seed.kgId, () =>
          h.invoiceRepo.listChildIdsWithPaidPrepaymentCovering(seed.kgId, JULY),
        );
        expect(covered).toEqual([childA]);

        const run = await h.processor.runForKindergarten(seed.kgId, JULY);
        expect(run).toEqual({ generated: 1, skipped: 1 });

        const monthlies = await readMonthlies(seed.kgId);
        expect(monthlies).toHaveLength(1);
        expect(monthlies[0].child_id).toBe(childB);
        expect(monthlies[0].status).toBe('pending');
        expect(monthlies[0].period_start).toBe('2026-07-01');
      } finally {
        await seed.cleanup();
      }
    });

    // ── Scenario 3: cross-tenant phantom (kg_A prepayment vs kg_B cron) ───

    it('isolates paid-prepayment coverage per tenant — kg_A prepayment neither suppresses kg_B billing nor leaks through the coverage query', async () => {
      const seedA = await seedKindergarten(1);
      const seedB = await seedKindergarten(1);
      try {
        const h = makeHarness();
        const childOfA = seedA.childIds[0];
        const childOfB = seedB.childIds[0];

        const prepayment = await inTenantTx(seedA.kgId, () =>
          h.invoiceService.prepayInvoice(seedA.kgId, childOfA, 3),
        );
        await markInvoicePaidRaw(prepayment.id);

        // Positive control: in its OWN kg the paid prepayment suppresses
        // the July cron entirely — proving the seed is coverage-effective,
        // so the kg_B assertions below are non-vacuous.
        const runA = await h.processor.runForKindergarten(seedA.kgId, JULY);
        expect(runA).toEqual({ generated: 0, skipped: 1 });
        expect(await readMonthlies(seedA.kgId)).toHaveLength(0);

        // Direction 1 — kg_B's cron for the same period is NOT suppressed
        // by kg_A's prepayment: kg_B's own child is billed normally.
        const runB = await h.processor.runForKindergarten(seedB.kgId, JULY);
        expect(runB).toEqual({ generated: 1, skipped: 0 });
        const monthliesB = await readMonthlies(seedB.kgId);
        expect(monthliesB).toHaveLength(1);
        expect(monthliesB[0].child_id).toBe(childOfB);
        expect(monthliesB[0].status).toBe('pending');

        // Direction 2 — the coverage query scoped to kg_B sees nothing…
        const coveredB = await inTenantTx(seedB.kgId, () =>
          h.invoiceRepo.listChildIdsWithPaidPrepaymentCovering(
            seedB.kgId,
            JULY,
          ),
        );
        expect(coveredB).toEqual([]);

        // …and RLS blocks the phantom even when kg_A's id is passed
        // explicitly under a kg_B tenant context (readRowsAsKgB pattern —
        // the WHERE alone must not be the only isolation layer).
        const phantom = await inTenantTx(seedB.kgId, () =>
          h.invoiceRepo.listChildIdsWithPaidPrepaymentCovering(
            seedA.kgId,
            JULY,
          ),
        );
        expect(phantom).toEqual([]);

        // Sanity: the same query under kg_A's own scope does see it.
        const coveredA = await inTenantTx(seedA.kgId, () =>
          h.invoiceRepo.listChildIdsWithPaidPrepaymentCovering(
            seedA.kgId,
            JULY,
          ),
        );
        expect(coveredA).toEqual([childOfA]);
      } finally {
        await seedA.cleanup();
        await seedB.cleanup();
      }
    });
  },
);
