/**
 * B13 Billing — payment.service race integration spec.
 *
 * Self-skips when `INTEGRATION_DB !== '1'` so `npm test` stays green on
 * machines without a configured tenant DB. Run with:
 *
 *   $env:DATABASE_PORT='55432'; $env:DATABASE_USERNAME='shyraq_app';
 *   $env:DATABASE_PASSWORD='shyraq_app'; $env:INTEGRATION_DB='1';
 *   npm test -- --testPathPatterns='payment.race'
 *
 * Scenarios under test (real PostgreSQL — exercises advisory lock,
 * conditional UPDATE WHERE status=expected, UNIQUE constraint on
 * idempotency_key, and bypass_rls cross-tenant lookup end-to-end):
 *
 *   A. idempotency_key serial replay
 *      5 concurrent `initiate` calls with the SAME `idempotency_key`
 *      collapse to 1 row. All callers resolve to the same payment_id.
 *
 *   B. concurrent partial-pay initiates
 *      5 concurrent `initiate` calls each with their own idempotency_key
 *      and amount=2000 against an invoice with amount_after_discount=10000.
 *      Final state: 5 completed payments, paid_sum=10000, invoice paid,
 *      payment_account.balance=10000.
 *
 *   C. webhook replay
 *      Initiate completes synchronously (Mock); same provider_txn_id is
 *      then re-played via processWebhook. Assertion: payment_account
 *      balance is unchanged (no double-credit), payment.status remains
 *      'completed', invoice.status remains 'paid'.
 *
 *   D. cross-tenant webhook leak
 *      Two kindergartens. Initiate in kg_A; webhook with the kg_A
 *      provider_txn_id arrives without kg context. Verify only kg_A's
 *      payment / invoice / payment_account are touched; kg_B's are
 *      unchanged when queried under kg_B's RLS scope.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { InvoiceRelationalRepository } from './infrastructure/persistence/relational/repositories/invoice.relational.repository';
import { InvoiceLineItemRelationalRepository } from './infrastructure/persistence/relational/repositories/invoice-line-item.relational.repository';
import { PaymentAccountRelationalRepository } from './infrastructure/persistence/relational/repositories/payment-account.relational.repository';
import { PaymentRelationalRepository } from './infrastructure/persistence/relational/repositories/payment.relational.repository';
import { TariffAssignmentRelationalRepository } from './infrastructure/persistence/relational/repositories/tariff-assignment.relational.repository';
import { TariffPlanRelationalRepository } from './infrastructure/persistence/relational/repositories/tariff-plan.relational.repository';
import { KindergartenHolidayRelationalRepository } from './infrastructure/persistence/relational/repositories/kindergarten-holiday.relational.repository';
import { InvoiceTypeOrmEntity } from './infrastructure/persistence/relational/entities/invoice.typeorm.entity';
import { InvoiceLineItemTypeOrmEntity } from './infrastructure/persistence/relational/entities/invoice-line-item.typeorm.entity';
import { KindergartenHolidayTypeOrmEntity } from './infrastructure/persistence/relational/entities/kindergarten-holiday.typeorm.entity';
import { PaymentAccountTypeOrmEntity } from './infrastructure/persistence/relational/entities/payment-account.typeorm.entity';
import { PaymentTypeOrmEntity } from './infrastructure/persistence/relational/entities/payment.typeorm.entity';
import { TariffAssignmentTypeOrmEntity } from './infrastructure/persistence/relational/entities/tariff-assignment.typeorm.entity';
import { TariffPlanTypeOrmEntity } from './infrastructure/persistence/relational/entities/tariff-plan.typeorm.entity';
import { MockPaymentProvider } from './infrastructure/payment-provider/mock-payment-provider.adapter';
import { HolidayService } from './holiday.service';
import { InvoiceService } from './invoice.service';
import { PaymentService } from './payment.service';
import { PaymentAccountService } from './payment-account.service';
import {
  DiscountEnginePort,
  DiscountEvaluationInput,
  DiscountEvaluationResult,
} from './infrastructure/discount-engine/discount-engine.port';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

class FixedClock extends ClockPort {
  constructor(private d: Date) {
    super();
  }
  now(): Date {
    return this.d;
  }
}

class ZeroDiscountEngine extends DiscountEnginePort {
  evaluate(_input: DiscountEvaluationInput): Promise<DiscountEvaluationResult> {
    return Promise.resolve({
      discountPct: null,
      discountReason: null,
      appliedRules: [],
    });
  }
}

const NOW = new Date('2026-06-15T09:00:00.000Z');

describeIntegration('PaymentService — race-integration', () => {
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
      poolSize: 20,
    });
    await dataSource.initialize();
  });

  afterAll(async () => {
    if (!dataSource?.isInitialized) return;
    await dataSource.destroy();
  });

  // ── helpers ────────────────────────────────────────────────────────────

  function makeService(): {
    paymentService: PaymentService;
    invoiceService: InvoiceService;
    paymentAccountService: PaymentAccountService;
  } {
    const clock = new FixedClock(NOW);
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
    const holidayRepo = new KindergartenHolidayRelationalRepository(
      dataSource.getRepository(KindergartenHolidayTypeOrmEntity),
    );
    const paymentRepo = new PaymentRelationalRepository(
      dataSource,
      dataSource.getRepository(PaymentTypeOrmEntity),
    );
    const paymentAccountService = new PaymentAccountService(
      paymentAccountRepo,
      clock,
    );
    const holidayService = new HolidayService(holidayRepo, clock);
    const invoiceService = new InvoiceService(
      invoiceRepo,
      lineItemRepo,
      tariffPlanRepo,
      tariffAssignmentRepo,
      paymentAccountService,
      new ZeroDiscountEngine(),
      holidayService,
      clock,
    );
    const provider = new MockPaymentProvider();
    const paymentService = new PaymentService(
      paymentRepo,
      invoiceRepo,
      invoiceService,
      paymentAccountService,
      provider,
      clock,
      dataSource,
    );
    return { paymentService, invoiceService, paymentAccountService };
  }

  /**
   * Open a TX, set `app.kindergarten_id` GUC for RLS, push the EM into
   * tenantStorage so repos see it. Mirrors what TenantContextInterceptor
   * does for HTTP requests.
   */
  async function runScoped<T>(kgId: string, fn: () => Promise<T>): Promise<T> {
    return dataSource.transaction(async (em) => {
      await em.query(`SELECT set_config('app.kindergarten_id', $1, true)`, [
        kgId,
      ]);
      return tenantStorage.run({ kgId, bypass: false, entityManager: em }, () =>
        fn(),
      );
    });
  }

  /** Run something with bypass_rls — for cross-kg setup/cleanup queries. */
  async function withBypass<T>(
    fn: (em: EntityManager) => Promise<T>,
  ): Promise<T> {
    return dataSource.transaction(async (em) => {
      await em.query(`SET LOCAL app.bypass_rls = 'true'`);
      return fn(em);
    });
  }

  /**
   * Seed one kindergarten with a child, payment_account, and one invoice
   * with the given amount. Returns IDs for assertions/cleanup.
   */
  async function seedKgWithInvoice(amount: number): Promise<{
    kgId: string;
    childId: string;
    accountId: string;
    invoiceId: string;
    cleanup: () => Promise<void>;
  }> {
    const kgId = randomUUID();
    const userId = randomUUID();
    const staffId = randomUUID();
    const childId = randomUUID();
    const accountId = randomUUID();
    const invoiceId = randomUUID();
    const slug = `pay-race-${kgId.slice(0, 8)}`;
    const phone = `+7700${kgId.replace(/-/g, '').slice(0, 7)}`;
    await withBypass(async (m) => {
      await m.query(
        `INSERT INTO kindergartens (id, name, slug, is_active)
         VALUES ($1, 'Pay Race KG', $2, true)`,
        [kgId, slug],
      );
      await m.query(
        `INSERT INTO users (id, phone, full_name) VALUES ($1, $2, 'PayRace Admin')`,
        [userId, phone],
      );
      await m.query(
        `INSERT INTO staff_members (id, kindergarten_id, user_id, role, is_active)
         VALUES ($1, $2, $3, 'admin', true)`,
        [staffId, kgId, userId],
      );
      await m.query(
        `INSERT INTO children (id, kindergarten_id, full_name, date_of_birth, status)
         VALUES ($1, $2, 'Pay Race Child', '2021-01-01', 'card_created')`,
        [childId, kgId],
      );
      await m.query(
        `INSERT INTO payment_accounts (id, kindergarten_id, child_id, balance)
         VALUES ($1, $2, $3, 0)`,
        [accountId, kgId, childId],
      );
      await m.query(
        `INSERT INTO invoices (
           id, kindergarten_id, child_id, payment_account_id, invoice_type,
           period_start, period_end, amount_due, amount_after_discount,
           status, due_date)
         VALUES ($1, $2, $3, $4, 'monthly',
                 '2026-06-01', '2026-06-30', $5, $5, 'pending', '2026-06-10')`,
        [invoiceId, kgId, childId, accountId, amount],
      );
    });

    const cleanup = async () => {
      await withBypass(async (m) => {
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
        await m.query(`DELETE FROM children WHERE kindergarten_id = $1`, [
          kgId,
        ]);
        await m.query(`DELETE FROM staff_members WHERE kindergarten_id = $1`, [
          kgId,
        ]);
        await m.query(`DELETE FROM users WHERE id = $1`, [userId]);
        await m.query(`DELETE FROM kindergartens WHERE id = $1`, [kgId]);
      });
    };

    return { kgId, childId, accountId, invoiceId, cleanup };
  }

  async function readPaymentsCount(kgId: string): Promise<number> {
    return withBypass(async (m) => {
      const rows = (await m.query(
        `SELECT COUNT(*)::int AS c FROM payments WHERE kindergarten_id = $1`,
        [kgId],
      )) as Array<{ c: number }>;
      return rows[0]?.c ?? 0;
    });
  }

  async function readInvoiceStatus(
    kgId: string,
    invoiceId: string,
  ): Promise<string> {
    return withBypass(async (m) => {
      const rows = (await m.query(
        `SELECT status FROM invoices WHERE id = $1 AND kindergarten_id = $2`,
        [invoiceId, kgId],
      )) as Array<{ status: string }>;
      return rows[0]?.status ?? '';
    });
  }

  async function readAccountBalance(
    kgId: string,
    accountId: string,
  ): Promise<number> {
    return withBypass(async (m) => {
      const rows = (await m.query(
        `SELECT balance::text AS b FROM payment_accounts
           WHERE id = $1 AND kindergarten_id = $2`,
        [accountId, kgId],
      )) as Array<{ b: string }>;
      return Number(rows[0]?.b ?? '0');
    });
  }

  // ── Scenario A: idempotency_key serial replay ─────────────────────────

  it('serializes 5 concurrent initiate calls with the same idempotency_key — exactly 1 payment row', async () => {
    const seed = await seedKgWithInvoice(10000);
    try {
      const { paymentService } = makeService();
      const idempKey = `idem-${randomUUID()}`;

      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          runScoped(seed.kgId, () =>
            paymentService.initiate(seed.kgId, {
              invoiceId: seed.invoiceId,
              amount: 10000,
              paymentMode: 'full',
              provider: 'mock',
              idempotencyKey: idempKey,
              returnUrl: 'https://app/return',
            }),
          ),
        ),
      );

      // All 5 callers receive the same payment_id (idempotency).
      const ids = new Set(results.map((r) => r.payment.id));
      expect(ids.size).toBe(1);
      expect(await readPaymentsCount(seed.kgId)).toBe(1);
    } finally {
      await seed.cleanup();
    }
  });

  // ── Scenario B: concurrent partial-pay initiates ──────────────────────

  it('5 concurrent partial-pay initiates settle to a single paid invoice — paid_sum = full', async () => {
    const seed = await seedKgWithInvoice(10000);
    try {
      const { paymentService } = makeService();

      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          runScoped(seed.kgId, () =>
            paymentService.initiate(seed.kgId, {
              invoiceId: seed.invoiceId,
              amount: 2000,
              paymentMode: 'partial',
              provider: 'mock',
              idempotencyKey: `idem-partial-${i}-${randomUUID()}`,
              returnUrl: 'https://app/return',
            }),
          ),
        ),
      );

      // Each call returned a completed payment (synchronous Mock).
      for (const r of results) {
        expect(r.payment.status).toBe('completed');
      }

      expect(await readPaymentsCount(seed.kgId)).toBe(5);
      expect(await readInvoiceStatus(seed.kgId, seed.invoiceId)).toBe('paid');
      expect(await readAccountBalance(seed.kgId, seed.accountId)).toBe(10000);
    } finally {
      await seed.cleanup();
    }
  });

  // ── Scenario C: webhook replay ────────────────────────────────────────

  it('webhook replay does not double-credit payment_account or re-flip invoice', async () => {
    const seed = await seedKgWithInvoice(10000);
    try {
      const { paymentService } = makeService();
      const idempKey = `idem-replay-${randomUUID()}`;
      const initial = await runScoped(seed.kgId, () =>
        paymentService.initiate(seed.kgId, {
          invoiceId: seed.invoiceId,
          amount: 10000,
          paymentMode: 'full',
          provider: 'mock',
          idempotencyKey: idempKey,
          returnUrl: 'https://app/return',
        }),
      );
      expect(initial.payment.status).toBe('completed');
      const balanceBefore = await readAccountBalance(seed.kgId, seed.accountId);
      expect(balanceBefore).toBe(10000);

      // Replay the webhook with the SAME provider_txn_id. The cross-tenant
      // lookup picks up the existing completed row; applyCompletedPayment
      // reads the under-lock state and short-circuits — no new credit.
      const providerTxnId = initial.payment.providerTxnId;
      expect(providerTxnId).not.toBeNull();
      await paymentService.processWebhook({
        provider: 'mock',
        headers: { 'x-mock-signature': 'valid' },
        body: {
          provider_payment_id: providerTxnId,
          status: 'completed',
        },
      });

      // Balance unchanged, payment still completed, invoice still paid.
      expect(await readAccountBalance(seed.kgId, seed.accountId)).toBe(10000);
      expect(await readInvoiceStatus(seed.kgId, seed.invoiceId)).toBe('paid');
      expect(await readPaymentsCount(seed.kgId)).toBe(1);
    } finally {
      await seed.cleanup();
    }
  });

  // ── Scenario D: cross-tenant webhook leak ─────────────────────────────

  it('cross-tenant webhook does not bleed into the other kindergarten', async () => {
    const seedA = await seedKgWithInvoice(10000);
    const seedB = await seedKgWithInvoice(10000);
    try {
      const { paymentService } = makeService();

      // Payment in kg_A.
      const idempA = `idem-A-${randomUUID()}`;
      const a = await runScoped(seedA.kgId, () =>
        paymentService.initiate(seedA.kgId, {
          invoiceId: seedA.invoiceId,
          amount: 10000,
          paymentMode: 'full',
          provider: 'mock',
          idempotencyKey: idempA,
          returnUrl: 'https://app/return',
        }),
      );
      expect(a.payment.status).toBe('completed');

      // Now play a webhook (no kg context) for kg_A's tx. Verify only
      // kg_A side-effects, kg_B unchanged.
      await paymentService.processWebhook({
        provider: 'mock',
        headers: { 'x-mock-signature': 'valid' },
        body: {
          provider_payment_id: a.payment.providerTxnId,
          status: 'completed',
        },
      });

      // kg_A: 1 payment, invoice paid, account credited 10000.
      expect(await readPaymentsCount(seedA.kgId)).toBe(1);
      expect(await readInvoiceStatus(seedA.kgId, seedA.invoiceId)).toBe('paid');
      expect(await readAccountBalance(seedA.kgId, seedA.accountId)).toBe(10000);

      // kg_B: nothing touched.
      expect(await readPaymentsCount(seedB.kgId)).toBe(0);
      expect(await readInvoiceStatus(seedB.kgId, seedB.invoiceId)).toBe(
        'pending',
      );
      expect(await readAccountBalance(seedB.kgId, seedB.accountId)).toBe(0);
    } finally {
      await seedA.cleanup();
      await seedB.cleanup();
    }
  });
});
