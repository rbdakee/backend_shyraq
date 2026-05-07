/**
 * B13 Billing — concurrent monthly-billing race spec.
 *
 * Self-skips when `INTEGRATION_DB !== '1'` so `npm test` stays green on
 * machines without a configured tenant DB. Run with:
 *
 *   $env:DATABASE_PORT='55432'; $env:DATABASE_USERNAME='shyraq_app';
 *   $env:DATABASE_PASSWORD='shyraq_app'; $env:INTEGRATION_DB='1';
 *   npm test -- --testPathPatterns='billing.race'
 *
 * What this guards: three orthogonal invariants of `MonthlyBillingProcessor`.
 *
 *   1. Idempotency under concurrent invocations. Five callers fire
 *      `runForKindergarten(kg, periodStart)` simultaneously. The
 *      advisory lock acquired inside `InvoiceService.generateMonthly`
 *      serialises them; the `existsAnyForPeriod` short-circuit kicks in
 *      after the winner commits. Post-condition: exactly one invoice
 *      per active tariff_assignment (5 assignments → 5 invoices), not
 *      25 invoices.
 *
 *   2. Cross-kg isolation. Two kindergartens, each with three children
 *      assigned to a monthly plan. Concurrent runs for both kgs do not
 *      bleed into each other — kg_A ends up with 3 invoices, kg_B with
 *      3 invoices, no phantoms.
 *
 *   3. Per-kg error isolation. The processor wraps each
 *      `runForKindergarten` in its own `dataSource.transaction()` and
 *      catches errors at the loop boundary. We inject a failure into
 *      the middle kg via a wrapper InvoiceService that throws for that
 *      kg's id only — the outer two kgs still get invoiced and the
 *      summary reports `errors: 1`.
 *
 * The spec instantiates the real `InvoiceService` (with real PG-backed
 * repositories) so the advisory lock + conditional UPDATE pattern is
 * exercised end-to-end through PostgreSQL — no in-memory shortcuts.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { InMemoryNotificationAdapter } from '@/common/notifications/in-memory-notification.adapter';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import {
  DiscountEnginePort,
  DiscountEvaluationInput,
  DiscountEvaluationResult,
} from './infrastructure/discount-engine/discount-engine.port';
import { InvoiceRelationalRepository } from './infrastructure/persistence/relational/repositories/invoice.relational.repository';
import { InvoiceLineItemRelationalRepository } from './infrastructure/persistence/relational/repositories/invoice-line-item.relational.repository';
import { KindergartenHolidayRelationalRepository } from './infrastructure/persistence/relational/repositories/kindergarten-holiday.relational.repository';
import { PaymentAccountRelationalRepository } from './infrastructure/persistence/relational/repositories/payment-account.relational.repository';
import { TariffAssignmentRelationalRepository } from './infrastructure/persistence/relational/repositories/tariff-assignment.relational.repository';
import { TariffPlanRelationalRepository } from './infrastructure/persistence/relational/repositories/tariff-plan.relational.repository';
import { InvoiceTypeOrmEntity } from './infrastructure/persistence/relational/entities/invoice.typeorm.entity';
import { InvoiceLineItemTypeOrmEntity } from './infrastructure/persistence/relational/entities/invoice-line-item.typeorm.entity';
import { KindergartenHolidayTypeOrmEntity } from './infrastructure/persistence/relational/entities/kindergarten-holiday.typeorm.entity';
import { PaymentAccountTypeOrmEntity } from './infrastructure/persistence/relational/entities/payment-account.typeorm.entity';
import { TariffAssignmentTypeOrmEntity } from './infrastructure/persistence/relational/entities/tariff-assignment.typeorm.entity';
import { TariffPlanTypeOrmEntity } from './infrastructure/persistence/relational/entities/tariff-plan.typeorm.entity';
import { HolidayService } from './holiday.service';
import { InvoiceService } from './invoice.service';
import { MonthlyBillingProcessor } from './monthly-billing.processor';
import { PaymentAccountService } from './payment-account.service';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

const PERIOD_START = new Date('2026-06-01T00:00:00.000Z');

class FixedClock extends ClockPort {
  constructor(private readonly d: Date) {
    super();
  }
  now(): Date {
    return this.d;
  }
}

/** Mock discount engine — zero discount for every invoice. */
class ZeroDiscountEngine extends DiscountEnginePort {
  evaluate(_input: DiscountEvaluationInput): Promise<DiscountEvaluationResult> {
    return Promise.resolve({
      discountPct: null,
      discountReason: null,
      appliedRules: [],
    });
  }
}

describeIntegration(
  'MonthlyBillingProcessor — concurrent runForKindergarten + cross-kg isolation + per-kg error isolation',
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

    /**
     * Construct a real `InvoiceService` wired against the live PG
     * dataSource. The repositories rely on `tenantStorage.getStore()`
     * for their EntityManager — the processor's `runForKindergarten`
     * publishes that context, so callers receive RLS-correct queries.
     */
    function makeInvoiceService(): InvoiceService {
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
      const clock = new FixedClock(PERIOD_START);
      const paymentAccountService = new PaymentAccountService(
        paymentAccountRepo,
        clock,
      );
      const holidayService = new HolidayService(holidayRepo, clock);
      const discountEngine = new ZeroDiscountEngine();
      const notifier = new InMemoryNotificationAdapter();
      return new InvoiceService(
        invoiceRepo,
        lineItemRepo,
        tariffPlanRepo,
        tariffAssignmentRepo,
        paymentAccountService,
        discountEngine,
        holidayService,
        notifier,
        clock,
      );
    }

    function makeProcessor(svc: InvoiceService): MonthlyBillingProcessor {
      return new MonthlyBillingProcessor(
        svc,
        dataSource,
        new FixedClock(PERIOD_START),
      );
    }

    /**
     * Seed one kindergarten with N children, each having an active
     * tariff_assignment to a single monthly plan. Returns the IDs so
     * the test can clean up + assert on them.
     */
    async function seedKindergarten(numChildren: number): Promise<{
      kgId: string;
      childIds: string[];
      planId: string;
      cleanup: () => Promise<void>;
    }> {
      const kgId = randomUUID();
      const userId = randomUUID();
      const staffId = randomUUID();
      const planId = randomUUID();
      const childIds: string[] = [];
      const assignmentIds: string[] = [];
      const accountIds: string[] = [];

      const slug = `race-billing-${kgId.slice(0, 8)}`;
      const phone = `+7700${kgId.replace(/-/g, '').slice(0, 7)}`;

      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(
          `INSERT INTO kindergartens (id, name, slug, is_active)
           VALUES ($1, 'Race Billing KG', $2, true)`,
          [kgId, slug],
        );
        await m.query(
          `INSERT INTO users (id, phone, full_name) VALUES ($1, $2, 'Race Admin')`,
          [userId, phone],
        );
        await m.query(
          `INSERT INTO staff_members (id, kindergarten_id, user_id, role, is_active)
           VALUES ($1, $2, $3, 'admin', true)`,
          [staffId, kgId, userId],
        );
        await m.query(
          `INSERT INTO tariff_plans
             (id, kindergarten_id, name, tariff_type, amount, applies_to, valid_from)
           VALUES ($1, $2, 'Race Plan', 'monthly', 50000, 'all_children', '2025-01-01')`,
          [planId, kgId],
        );
        for (let i = 0; i < numChildren; i++) {
          const childId = randomUUID();
          const assignmentId = randomUUID();
          const accountId = randomUUID();
          childIds.push(childId);
          assignmentIds.push(assignmentId);
          accountIds.push(accountId);
          await m.query(
            `INSERT INTO children (id, kindergarten_id, full_name, date_of_birth, status)
             VALUES ($1, $2, $3, '2021-01-01', 'card_created')`,
            [childId, kgId, `Race Child ${i + 1}`],
          );
          await m.query(
            `INSERT INTO tariff_assignments
               (id, kindergarten_id, child_id, tariff_plan_id, valid_from, assigned_by)
             VALUES ($1, $2, $3, $4, '2025-01-01', $5)`,
            [assignmentId, kgId, childId, planId, userId],
          );
          // Pre-create payment accounts so the service's
          // `ensureForChild` hits the existing-row path. This avoids
          // a separate concurrent-insert race on the
          // `(kg, child) UNIQUE` constraint that's orthogonal to the
          // invariant under test (advisory lock for invoice generation).
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

      return { kgId, childIds, planId, cleanup };
    }

    async function countInvoices(kgId: string): Promise<number> {
      return dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        const rows = (await m.query(
          `SELECT COUNT(*)::int AS c FROM invoices WHERE kindergarten_id = $1`,
          [kgId],
        )) as Array<{ c: number }>;
        return rows[0]?.c ?? 0;
      });
    }

    // ── Scenario 1: idempotency under concurrent same-period invocations ──

    it('serializes 5 concurrent runForKindergarten calls — exactly N invoices created (one per active assignment)', async () => {
      const seed = await seedKindergarten(5);
      try {
        const svc = makeInvoiceService();
        const processor = makeProcessor(svc);

        // Five concurrent invocations of runForKindergarten for the
        // SAME (kg, periodStart). The advisory lock keyed on
        // hashtext('billing:monthly:'||kgId||':'||YYYY-MM) serialises
        // them inside `InvoiceService.generateMonthly`. The first
        // committer sets up 5 invoices; subsequent callers hit the
        // `existsAnyForPeriod` short-circuit and return
        // `{generated: 0, skipped: 5}`.
        const results = await Promise.all(
          Array.from({ length: 5 }, () =>
            processor.runForKindergarten(seed.kgId, PERIOD_START),
          ),
        );

        const totalGenerated = results.reduce((s, r) => s + r.generated, 0);
        const totalSkipped = results.reduce((s, r) => s + r.skipped, 0);

        // Exactly one caller actually wrote invoices. The other four
        // saw the existing-period short-circuit. Either way the DB
        // ends up with exactly N invoices (one per assignment) — never
        // 5*N.
        expect(totalGenerated).toBe(5);
        expect(totalSkipped).toBe(20); // 4 callers × 5 assignments

        const dbCount = await countInvoices(seed.kgId);
        expect(dbCount).toBe(5);
      } finally {
        await seed.cleanup();
      }
    });

    // ── Scenario 2: cross-kg isolation ──────────────────────────────────

    it('cross-kg isolation — concurrent runs across two kindergartens do not bleed', async () => {
      const seedA = await seedKindergarten(3);
      const seedB = await seedKindergarten(3);
      try {
        const svc = makeInvoiceService();
        const processor = makeProcessor(svc);

        // Interleave runs across both kgs. Each pair fires the same
        // (kg, period) twice — the advisory lock dedupes within the
        // kg, and there's no cross-kg contention because the lock key
        // includes the kg id.
        const results = await Promise.all([
          processor.runForKindergarten(seedA.kgId, PERIOD_START),
          processor.runForKindergarten(seedB.kgId, PERIOD_START),
          processor.runForKindergarten(seedA.kgId, PERIOD_START),
          processor.runForKindergarten(seedB.kgId, PERIOD_START),
        ]);

        // Two of the four results write 3 invoices each (the winners
        // for each kg). The other two see the short-circuit.
        const totalGenerated = results.reduce((s, r) => s + r.generated, 0);
        expect(totalGenerated).toBe(6);

        expect(await countInvoices(seedA.kgId)).toBe(3);
        expect(await countInvoices(seedB.kgId)).toBe(3);
      } finally {
        await seedA.cleanup();
        await seedB.cleanup();
      }
    });

    // ── Scenario 3: per-kg error isolation in the top-level loop ────────

    it('per-kg error isolation — failing kg does not block surrounding kgs in the batch loop', async () => {
      const seedA = await seedKindergarten(2);
      const seedFail = await seedKindergarten(2);
      const seedC = await seedKindergarten(2);
      try {
        const svc = makeInvoiceService();
        // Wrap the real service so generateMonthly throws for
        // `seedFail.kgId` only and delegates for the rest. We do this
        // via prototype patching on the instance the processor will
        // call — the wrapped method preserves all other paths.
        const realGenerateMonthly = svc.generateMonthly.bind(svc);
        jest
          .spyOn(svc, 'generateMonthly')
          .mockImplementation((kgId, periodStart) => {
            if (kgId === seedFail.kgId) {
              return Promise.reject(
                new Error(`injected failure for kg=${kgId}`),
              );
            }
            return realGenerateMonthly(kgId, periodStart);
          });

        // Drive the processor `process()` directly — ensures the
        // top-level kg loop is the path under test, including its
        // try/catch + summary aggregation.
        const fakeJob = {
          name: 'billing-monthly-manual',
          data: { periodStart: PERIOD_START.toISOString().slice(0, 10) },
        } as unknown as import('bullmq').Job;

        // Inject our three kg ids into the listAllKindergartens path
        // by stubbing only that helper. The processor's per-kg TX,
        // tenantStorage scoping, and try/catch still execute against
        // real PG.
        jest
          .spyOn(processorPrototype(), 'listAllKindergartens' as never)
          .mockResolvedValue([seedA.kgId, seedFail.kgId, seedC.kgId] as never);

        const processor = makeProcessor(svc);
        const summary = await processor.process(fakeJob);

        expect(summary.kindergartensProcessed).toBe(3);
        expect(summary.errors).toBe(1);
        // Two kgs × 2 children each = 4 invoices generated by the
        // succeeding pair; the failing kg's TX rolled back so it has
        // none.
        expect(summary.invoicesGenerated).toBe(4);

        expect(await countInvoices(seedA.kgId)).toBe(2);
        expect(await countInvoices(seedFail.kgId)).toBe(0);
        expect(await countInvoices(seedC.kgId)).toBe(2);
      } finally {
        jest.restoreAllMocks();
        await seedA.cleanup();
        await seedFail.cleanup();
        await seedC.cleanup();
      }
    });
  },
);

/**
 * Returns the prototype object spy targets need. Avoids introducing a
 * top-level import cycle and keeps the spec readable — the per-kg
 * isolation test is the only path that stubs `listAllKindergartens`,
 * so isolating the prototype reference here makes the intent obvious.
 */
function processorPrototype(): MonthlyBillingProcessor {
  return MonthlyBillingProcessor.prototype as unknown as MonthlyBillingProcessor;
}
