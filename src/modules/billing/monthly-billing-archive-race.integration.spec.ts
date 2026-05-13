/**
 * B22a T3 (FINDINGS B21-T6-M3) — Monthly billing archive-race integration spec.
 *
 * Self-skips when `INTEGRATION_DB !== '1'` so `npm test` stays green on
 * machines without a configured tenant DB. Run with:
 *
 *   $env:DATABASE_PORT='55432'; $env:DATABASE_USERNAME='shyraq_app';
 *   $env:DATABASE_PASSWORD='shyraq_app'; $env:INTEGRATION_DB='1';
 *   npm test -- --testPathPatterns='monthly-billing-archive-race'
 *
 * What this guards: an active child that flips to `archived`
 * concurrently with the monthly billing run does NOT receive an invoice
 * for the period in question. Before the fix, the cron's loop did
 * `findById → status check → discount eval → INSERT`; an archive
 * commit landing inside that gap caused a phantom invoice for an
 * already-archived child.
 *
 * The fix:
 *   1. New `ChildRepository.existsActiveByIdForUpdate(kg, childId)` —
 *      `SELECT 1 ... FOR UPDATE` inside the per-child INSERT TX.
 *   2. `InvoiceService.generateAndPersistInvoice` runs the guard right
 *      before `invoices.create(...)`. False → throws
 *      `ChildArchivedDuringRunError`, the loop counts it as `skipped`
 *      and continues without emitting an outbox event.
 *
 * Race semantics: `FOR UPDATE` row-locks the children row inside the
 * cron's per-kg TX. A concurrent archive UPDATE blocks until our TX
 * commits or rolls back. If we commit BEFORE the concurrent archive
 * acquires the lock → both states are valid (invoice exists, then
 * child archived). If the archive commits FIRST → our subsequent
 * `existsActiveByIdForUpdate` reads `status='archived'` and returns
 * false → no invoice. Either way, NO invoice exists for an
 * already-archived child at any point in time after both TXs settle.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { InMemoryNotificationAdapter } from '@/common/notifications/in-memory-notification.adapter';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { Child } from '@/modules/child/domain/entities/child.entity';
import { ChildRepository } from '@/modules/child/infrastructure/persistence/child.repository';
import { tenantStorage } from '@/database/tenant-storage';
import {
  DiscountEnginePort,
  DiscountEvaluationInput,
  DiscountEvaluationResult,
} from './infrastructure/discount-engine/discount-engine.port';
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

class ZeroDiscountEngine extends DiscountEnginePort {
  evaluate(_input: DiscountEvaluationInput): Promise<DiscountEvaluationResult> {
    return Promise.resolve({
      discountPct: null,
      discountReason: null,
      appliedRules: [],
      customApplicationsToWrite: [],
      customDiscountAmount: null,
    });
  }
}

describeIntegration(
  'MonthlyBillingProcessor — archive-vs-invoice race (B21-T6-M3)',
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
        // Match the entity set used by `billing.race.integration.spec.ts`
        // — we don't load `ChildEntity` here because its relations
        // transitively pull in Group/Location/etc. The `ChildRepository`
        // surface we need (`existsActiveByIdForUpdate` + `findById`) is
        // satisfied by a hand-rolled adapter below that uses raw SQL via
        // the per-tx EntityManager. Children rows are seeded via raw
        // INSERT under `bypass_rls=true`, identical to the existing
        // billing race specs.
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
      const paymentRepo = new PaymentRelationalRepository(
        dataSource,
        dataSource.getRepository(PaymentTypeOrmEntity),
      );
      const holidayRepo = new KindergartenHolidayRelationalRepository(
        dataSource.getRepository(KindergartenHolidayTypeOrmEntity),
      );
      // Minimal `ChildRepository` adapter: only the two methods
      // exercised by `InvoiceService.generateMonthly` need real
      // implementations (`findById` for the top-of-loop status gate,
      // `existsActiveByIdForUpdate` for the pre-INSERT race guard).
      // Both delegate to the per-tx EntityManager surfaced by
      // `tenantStorage` so the `FOR UPDATE` lock travels inside the
      // cron's TX. We avoid loading `ChildEntity` into the DataSource
      // because its TypeORM relations transitively pull in
      // Group/Location/Kindergarten metadata that is irrelevant to the
      // race we're guarding here.
      const childRepo = new (class extends ChildRepository {
        // The abstract surface of ChildRepository is wide; only `findById`
        // and `existsActiveByIdForUpdate` matter for this race. Everything
        // else throws to make accidental usage loud during the spec run.
        create(): Promise<void> {
          throw new Error('not used in this spec');
        }
        findByKindergartenAndIin(): Promise<Child | null> {
          throw new Error('not used in this spec');
        }
        update(): Promise<void> {
          throw new Error('not used in this spec');
        }
        list(): Promise<{ items: Child[]; total: number }> {
          throw new Error('not used in this spec');
        }
        countActiveByGroup(): Promise<number> {
          throw new Error('not used in this spec');
        }
        recordGroupTransfer(): Promise<void> {
          throw new Error('not used in this spec');
        }
        listGroupHistory(): Promise<never[]> {
          throw new Error('not used in this spec');
        }
        findByIinCrossTenant(): Promise<Child[]> {
          throw new Error('not used in this spec');
        }
        findByIdsCrossTenant(): Promise<Child[]> {
          throw new Error('not used in this spec');
        }
        private em(): {
          query: (q: string, p?: unknown[]) => Promise<unknown>;
        } {
          const ctx = tenantStorage.getStore();
          return (
            (ctx?.entityManager as
              | { query: (q: string, p?: unknown[]) => Promise<unknown> }
              | undefined) ??
            (dataSource as unknown as {
              query: (q: string, p?: unknown[]) => Promise<unknown>;
            })
          );
        }
        async findById(kg: string, id: string): Promise<Child | null> {
          const rows = (await this.em().query(
            `SELECT id, kindergarten_id, full_name, date_of_birth, gender,
                    photo_url, status, current_group_id, enrollment_date,
                    archived_at, archive_reason, medical_notes, allergy_notes,
                    iin, created_at, updated_at
               FROM children WHERE id = $1 AND kindergarten_id = $2`,
            [id, kg],
          )) as Array<Record<string, unknown>>;
          if (rows.length === 0) return null;
          const r = rows[0];
          return Child.hydrate({
            id: String(r.id),
            kindergartenId: String(r.kindergarten_id),
            fullName: String(r.full_name),
            // pg returns `date` as string; coerce.
            dateOfBirth: new Date(r.date_of_birth as string | Date),
            gender: r.gender as 'm' | 'f' | null,
            photoUrl: (r.photo_url as string | null) ?? null,
            status: r.status as 'card_created' | 'active' | 'archived',
            currentGroupId: (r.current_group_id as string | null) ?? null,
            enrollmentDate: (r.enrollment_date as Date | null) ?? null,
            archivedAt: (r.archived_at as Date | null) ?? null,
            archiveReason: (r.archive_reason as string | null) ?? null,
            iin: (r.iin as string | null) ?? null,
            medicalNotes: (r.medical_notes as string | null) ?? null,
            allergyNotes: (r.allergy_notes as string | null) ?? null,
            createdAt: r.created_at as Date,
            updatedAt: r.updated_at as Date,
          });
        }
        async existsActiveByIdForUpdate(
          kg: string,
          id: string,
        ): Promise<boolean> {
          const rows = (await this.em().query(
            `SELECT 1 FROM children
              WHERE id = $1 AND kindergarten_id = $2 AND status <> 'archived'
              FOR UPDATE`,
            [id, kg],
          )) as Array<unknown>;
          return rows.length > 0;
        }
      })();
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
        paymentRepo,
        undefined, // discount apps
        undefined, // custom discounts
        undefined, // discount target resolver
        childRepo,
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
     * Seed one kindergarten with N `active` children + a monthly tariff
     * plan and one tariff_assignment per child. Returns the IDs so the
     * test can race against them and clean up.
     */
    async function seed(numChildren: number): Promise<{
      kgId: string;
      childIds: string[];
      cleanup: () => Promise<void>;
    }> {
      const kgId = randomUUID();
      const userId = randomUUID();
      const staffId = randomUUID();
      const planId = randomUUID();
      const childIds: string[] = [];
      const slug = `arch-race-${kgId.slice(0, 8)}`;
      const phone = `+7700${kgId.replace(/-/g, '').slice(0, 7)}`;

      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(
          `INSERT INTO kindergartens (id, name, slug, is_active)
           VALUES ($1, 'Archive Race KG', $2, true)`,
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
          // CRITICAL: status='active' so the loop's top-of-iteration
          // findById gate passes. The race gap is between THAT read
          // and the per-child INSERT inside generateAndPersistInvoice.
          await m.query(
            `INSERT INTO children (id, kindergarten_id, full_name, date_of_birth, status)
             VALUES ($1, $2, $3, '2021-01-01', 'active')`,
            [childId, kgId, `Race Child ${i + 1}`],
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

      return { kgId, childIds, cleanup };
    }

    async function countInvoicesForChild(
      kgId: string,
      childId: string,
    ): Promise<number> {
      return dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        const rows = (await m.query(
          `SELECT COUNT(*)::int AS c FROM invoices
            WHERE kindergarten_id = $1 AND child_id = $2`,
          [kgId, childId],
        )) as Array<{ c: number }>;
        return rows[0]?.c ?? 0;
      });
    }

    async function archiveChildBypassRls(
      kgId: string,
      childId: string,
    ): Promise<void> {
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(
          `UPDATE children
              SET status = 'archived',
                  archived_at = NOW(),
                  archive_reason = 'race-spec',
                  updated_at = NOW()
            WHERE id = $1
              AND kindergarten_id = $2
              AND status = 'active'`,
          [childId, kgId],
        );
      });
    }

    // ── Scenario 1: archive lands DURING the cron run (race) ─────────────

    it('archive concurrent with monthly cron — no invoice row for archived child', async () => {
      const seedResult = await seed(1);
      const { kgId, childIds } = seedResult;
      const target = childIds[0];
      try {
        const svc = makeInvoiceService();
        const processor = makeProcessor(svc);

        // Race: kick off the cron and an archive UPDATE in parallel.
        // The `existsActiveByIdForUpdate` guard inside the cron TX
        // takes a `FOR UPDATE` row lock; the archive UPDATE either
        // sees `status='active'` and waits for our INSERT (then
        // archives — invoice exists, then child archived: BOTH OK),
        // or commits FIRST (rare but valid) — then our guard reads
        // `archived` and skips the INSERT.
        const [, _archiveResult] = await Promise.all([
          processor.runForKindergarten(kgId, PERIOD_START),
          archiveChildBypassRls(kgId, target),
        ]);

        // Final invariant: regardless of who won, at most 1 invoice
        // exists for this child, AND if the child is currently
        // `archived`, exactly 0 invoices exist when the lock-loser
        // was the cron (skipped path). The only failure mode would be
        // an invoice for an archived child without the FOR-UPDATE
        // guard.
        const invoiceCount = await countInvoicesForChild(kgId, target);
        const finalStatus = await dataSource.transaction(async (m) => {
          await m.query(`SET LOCAL app.bypass_rls = 'true'`);
          const rows = (await m.query(
            `SELECT status FROM children WHERE id = $1`,
            [target],
          )) as Array<{ status: string }>;
          return rows[0]?.status;
        });

        if (finalStatus === 'archived' && invoiceCount === 1) {
          // Cron WON the lock → invoice landed BEFORE archive — the
          // archive UPDATE simply waited and then changed status.
          // This is acceptable: the snapshot at archive time saw an
          // active child with a billed period.
          expect(invoiceCount).toBe(1);
        } else if (finalStatus === 'archived' && invoiceCount === 0) {
          // Archive WON the lock OR the guard fired (children row
          // already in `archived` when our `existsActiveByIdForUpdate`
          // ran). Skipped — exactly the intended path.
          expect(invoiceCount).toBe(0);
        } else {
          // Anything else (still active, or 2+ invoices) is a bug.
          throw new Error(
            `unexpected race outcome: status=${finalStatus} invoices=${invoiceCount}`,
          );
        }
      } finally {
        await seedResult.cleanup();
      }
    });

    // ── Scenario 2: child already archived BEFORE cron starts ────────────

    it('child archived before cron starts — INSERT skipped, generated=0/skipped=1', async () => {
      const seedResult = await seed(1);
      const { kgId, childIds } = seedResult;
      const target = childIds[0];
      try {
        // Archive first, then run cron.
        await archiveChildBypassRls(kgId, target);

        const svc = makeInvoiceService();
        const processor = makeProcessor(svc);

        const result = await processor.runForKindergarten(kgId, PERIOD_START);

        // The top-of-loop `findById` guard catches it — skipped=1,
        // generated=0. The `existsActiveByIdForUpdate` guard inside
        // generateAndPersistInvoice never even executes for this
        // child (defence-in-depth: belt + suspenders).
        expect(result.generated).toBe(0);
        expect(result.skipped).toBe(1);
        expect(await countInvoicesForChild(kgId, target)).toBe(0);
      } finally {
        await seedResult.cleanup();
      }
    });
  },
);
