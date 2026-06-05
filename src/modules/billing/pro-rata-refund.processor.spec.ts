import { Job } from 'bullmq';
import { DataSource, EntityManager } from 'typeorm';
import { MoneyKzt } from '@/shared-kernel/domain/money-kzt';
import { Child } from '@/modules/child/domain/entities/child.entity';
import { ChildRepository } from '@/modules/child/infrastructure/persistence/child.repository';
import {
  LIFECYCLE_PRO_RATA_REFUND_JOB,
  ProRataRefundJobData,
} from '@/modules/child/lifecycle-queue.constants';
import { ChildId } from '@/shared-kernel/domain/value-objects/child-id.vo';
import { KindergartenId } from '@/shared-kernel/domain/value-objects/kindergarten-id.vo';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { Invoice } from './domain/entities/invoice.entity';
import { Payment } from './domain/entities/payment.entity';
import { Refund } from './domain/entities/refund.entity';
import { InvoiceRepository } from './infrastructure/persistence/invoice.repository';
import { KindergartenHolidayRepository } from './infrastructure/persistence/kindergarten-holiday.repository';
import { PaymentRepository } from './infrastructure/persistence/payment.repository';
import { RefundRepository } from './infrastructure/persistence/refund.repository';
import { ChildNotYetArchivedError } from './domain/errors/child-not-yet-archived.error';
import {
  PRO_RATA_COMMIT_GRACE_MS,
  PRO_RATA_REFUND_REASON,
  ProRataRefundProcessor,
} from './pro-rata-refund.processor';

const KG = '11111111-1111-1111-1111-111111111111';
const CHILD = '22222222-2222-2222-2222-222222222222';
const INVOICE = '33333333-3333-3333-3333-333333333333';
const PAYMENT = '44444444-4444-4444-4444-444444444444';
const NOW = new Date('2026-06-15T09:00:00.000Z');

class FixedClock extends ClockPort {
  constructor(private fixed: Date) {
    super();
  }
  now(): Date {
    return this.fixed;
  }
}

class FakeChildRepo extends ChildRepository {
  child: Child | null = null;

  create(): Promise<void> {
    return Promise.resolve();
  }
  findById(_kg: string, id: string): Promise<Child | null> {
    return Promise.resolve(
      this.child && this.child.id === id ? this.child : null,
    );
  }
  findByKindergartenAndIin(): Promise<Child | null> {
    return Promise.resolve(null);
  }
  update(): Promise<void> {
    return Promise.resolve();
  }
  list(): Promise<{ items: Child[]; total: number }> {
    return Promise.resolve({ items: [], total: 0 });
  }
  countActiveByGroup(): Promise<number> {
    return Promise.resolve(0);
  }
  recordGroupTransfer(): Promise<void> {
    return Promise.resolve();
  }
  listGroupHistory(): Promise<never[]> {
    return Promise.resolve([]);
  }
  findByIinCrossTenant(): Promise<Child[]> {
    return Promise.resolve([]);
  }
  findByIdsCrossTenant(): Promise<Child[]> {
    return Promise.resolve([]);
  }
}

class FakeRefundRepo extends RefundRepository {
  refunds: Refund[] = [];
  preExistingProRata: Refund[] = [];
  acquireCalls = 0;

  create(refund: Refund): Promise<Refund> {
    this.refunds.push(refund);
    return Promise.resolve(refund);
  }
  findById(): Promise<Refund | null> {
    return Promise.resolve(null);
  }
  findByPaymentId(): Promise<Refund[]> {
    return Promise.resolve([]);
  }
  list(): Promise<Refund[]> {
    return Promise.resolve([]);
  }
  markApprovedConditional(): Promise<Refund | null> {
    return Promise.resolve(null);
  }
  markRejectedConditional(): Promise<Refund | null> {
    return Promise.resolve(null);
  }
  markProcessedConditional(): Promise<Refund | null> {
    return Promise.resolve(null);
  }
  acquireRefundProcessAdvisoryLock(): Promise<void> {
    return Promise.resolve();
  }
  getProcessedRefundsSumForInvoice(): Promise<number> {
    return Promise.resolve(0);
  }

  override acquireProRataAdvisoryLock(): Promise<void> {
    this.acquireCalls += 1;
    return Promise.resolve();
  }
  override findPendingProRataForChildSinceArchive(
    _kg: string,
    _childId: string,
    since: Date,
  ): Promise<Refund[]> {
    // Real repo filters with `r.created_at >= since` AND
    // `r.reason = 'pro_rata_archive'`. The fake mirrors both filters so
    // archive→reactivate→archive scenarios can be exercised: the second
    // archive's `since` is later than the first refund's createdAt, so
    // the first refund correctly drops out.
    const filtered = this.preExistingProRata.filter(
      (r) => r.reason === PRO_RATA_REFUND_REASON && r.createdAt >= since,
    );
    return Promise.resolve(filtered);
  }
}

class FakeInvoiceRepo extends InvoiceRepository {
  current: Invoice | null = null;

  create(): Promise<Invoice> {
    return Promise.reject(new Error('not used'));
  }
  findById(): Promise<Invoice | null> {
    return Promise.resolve(null);
  }
  list(): Promise<Invoice[]> {
    return Promise.resolve([]);
  }
  findByChildId(): Promise<Invoice[]> {
    return Promise.resolve([]);
  }
  existsMonthlyForPeriod(): Promise<boolean> {
    return Promise.resolve(false);
  }
  getPaidSumForInvoice(): Promise<number> {
    return Promise.resolve(0);
  }
  markPaidConditional(): Promise<Invoice | null> {
    return Promise.resolve(null);
  }
  markPartialConditional(): Promise<Invoice | null> {
    return Promise.resolve(null);
  }
  markCancelledConditional(): Promise<Invoice | null> {
    return Promise.resolve(null);
  }
  markRefundedConditional(): Promise<Invoice | null> {
    return Promise.resolve(null);
  }
  markOverdueConditional(): Promise<Invoice | null> {
    return Promise.resolve(null);
  }
  acquireMonthlyGenerationAdvisoryLock(): Promise<void> {
    return Promise.resolve();
  }
  override findCurrentInvoiceForChildAt(): Promise<Invoice | null> {
    return Promise.resolve(this.current);
  }
}

class FakePaymentRepo extends PaymentRepository {
  paymentsByInvoiceId = new Map<string, Payment[]>();

  acquirePaymentAdvisoryLock(): Promise<void> {
    return Promise.resolve();
  }
  create(): Promise<Payment> {
    return Promise.reject(new Error('not used'));
  }
  findById(): Promise<Payment | null> {
    return Promise.resolve(null);
  }
  findByIdempotencyKey(): Promise<Payment | null> {
    return Promise.resolve(null);
  }
  findByInvoiceId(_kg: string, invoiceId: string): Promise<Payment[]> {
    return Promise.resolve(this.paymentsByInvoiceId.get(invoiceId) ?? []);
  }
  list(): Promise<Payment[]> {
    return Promise.resolve([]);
  }
  findByProviderTxnIdCrossTenant(): Promise<Payment | null> {
    return Promise.resolve(null);
  }
  findByIdCrossTenant(): Promise<Payment | null> {
    return Promise.resolve(null);
  }
  markCompletedConditional(): Promise<Payment | null> {
    return Promise.resolve(null);
  }
  markFailedConditional(): Promise<Payment | null> {
    return Promise.resolve(null);
  }
  markProcessingConditional(): Promise<Payment | null> {
    return Promise.resolve(null);
  }
  markRefundedConditional(): Promise<Payment | null> {
    return Promise.resolve(null);
  }
}

class FakeHolidayRepo extends KindergartenHolidayRepository {
  /** Map of `${YYYY-MM-DD}` for is_billable=false days. */
  nonBillableDays = new Set<string>();

  create(): Promise<never> {
    return Promise.reject(new Error('not used'));
  }
  update(): Promise<null> {
    return Promise.resolve(null);
  }
  delete(): Promise<void> {
    return Promise.resolve();
  }
  findById(): Promise<null> {
    return Promise.resolve(null);
  }
  list(): Promise<never[]> {
    return Promise.resolve([]);
  }
  countNonBillableInRange(_kg: string, from: Date, to: Date): Promise<number> {
    let n = 0;
    for (const ds of this.nonBillableDays) {
      const d = new Date(`${ds}T00:00:00.000Z`);
      if (d >= from && d <= to) n += 1;
    }
    return Promise.resolve(n);
  }
}

/**
 * Minimal DataSource stub — the processor wraps `runForChild` in
 * `dataSource.transaction(em => …)`. The fake invokes the callback
 * synchronously with a no-op manager so `em.query` (used for the
 * `set_config` GUC) doesn't throw.
 */
const fakeManager = {
  query: (_sql: string, _args?: unknown[]): Promise<unknown> =>
    Promise.resolve(undefined),
} as unknown as EntityManager;

const fakeDataSource = {
  transaction: <T>(cb: (m: EntityManager) => Promise<T>): Promise<T> =>
    cb(fakeManager),
} as unknown as DataSource;

function makeActiveThenArchivedChild(): Child {
  const c = Child.createNew({
    id: ChildId.parse(CHILD),
    kindergartenId: KindergartenId.parse(KG),
    fullName: 'Айгерим',
    dateOfBirth: new Date('2021-09-15'),
    now: new Date('2026-04-01T00:00:00.000Z'),
  });
  c.activate(new Date('2026-04-01T00:00:00.000Z'));
  c.archive(NOW, 'parent withdrew', 'staff-1');
  return c;
}

function makeInvoice(
  periodStart: Date,
  periodEnd: Date,
  amount = 60000,
): Invoice {
  return Invoice.fromState({
    id: INVOICE,
    kindergartenId: KG,
    childId: CHILD,
    paymentAccountId: 'pa-1',
    tariffPlanId: null,
    invoiceType: 'monthly',
    periodStart,
    periodEnd,
    amountDue: MoneyKzt.fromKzt(amount),
    discountPct: null,
    discountReason: null,
    amountAfterDiscount: MoneyKzt.fromKzt(amount),
    status: 'pending',
    dueDate: periodStart,
    description: null,
    proratedForDays: null,
    createdAt: periodStart,
    updatedAt: periodStart,
  });
}

function wire() {
  const refundRepo = new FakeRefundRepo();
  const invoiceRepo = new FakeInvoiceRepo();
  const holidayRepo = new FakeHolidayRepo();
  const paymentRepo = new FakePaymentRepo();
  const childRepo = new FakeChildRepo();
  const clock = new FixedClock(NOW);
  const processor = new ProRataRefundProcessor(
    refundRepo,
    invoiceRepo,
    holidayRepo,
    paymentRepo,
    childRepo,
    clock,
    fakeDataSource,
  );
  return {
    refundRepo,
    invoiceRepo,
    holidayRepo,
    paymentRepo,
    childRepo,
    clock,
    processor,
  };
}

function makeCompletedPayment(invoiceId: string, amount = 60000): Payment {
  return Payment.fromState({
    id: PAYMENT,
    kindergartenId: KG,
    invoiceId,
    childId: CHILD,
    payerUserId: null,
    amount: MoneyKzt.fromKzt(amount),
    provider: 'mock',
    providerTxnId: 'tx-1',
    status: 'completed',
    providerPayload: null,
    paidAt: new Date('2026-06-10T00:00:00.000Z'),
    refundId: null,
    idempotencyKey: 'k-1',
    createdAt: new Date('2026-06-10T00:00:00.000Z'),
    updatedAt: new Date('2026-06-10T00:00:00.000Z'),
  });
}

function makeJob(data: ProRataRefundJobData): Job<ProRataRefundJobData> {
  return {
    name: LIFECYCLE_PRO_RATA_REFUND_JOB,
    data,
  } as unknown as Job<ProRataRefundJobData>;
}

describe('ProRataRefundProcessor', () => {
  const archivedAt = NOW;
  const periodStart = new Date('2026-06-01T00:00:00.000Z');
  const periodEnd = new Date('2026-06-30T00:00:00.000Z');

  it('creates a refund proportional to remaining billable days (happy path, no holidays)', async () => {
    const w = wire();
    w.childRepo.child = makeActiveThenArchivedChild();
    w.invoiceRepo.current = makeInvoice(periodStart, periodEnd);
    w.paymentRepo.paymentsByInvoiceId.set(INVOICE, [
      makeCompletedPayment(INVOICE),
    ]);

    const result = await w.processor.process(
      makeJob({
        kindergartenId: KG,
        childId: CHILD,
        archivedAt: archivedAt.toISOString(),
      }),
    );

    expect(result.kind).toBe('created');
    if (result.kind === 'created') {
      // Period 2026-06-01..2026-06-30 = 30 days, archive on 2026-06-15
      // (Asia/Almaty → 2026-06-15 local-day, 15 days elapsed inclusive).
      // refundableDays = 30 - 15 = 15. amount = 60000 * 15/30 = 30000.
      expect(result.amountKzt).toBe(30000);
      expect(result.invoiceId).toBe(INVOICE);
    }
    expect(w.refundRepo.refunds).toHaveLength(1);
    expect(w.refundRepo.refunds[0].reason).toBe(PRO_RATA_REFUND_REASON);
    expect(w.refundRepo.refunds[0].status).toBe('pending');
    expect(w.refundRepo.refunds[0].paymentId).toBe(PAYMENT);
    expect(w.refundRepo.acquireCalls).toBe(1);
  });

  it('skips when the current invoice has no completed payment yet', async () => {
    const w = wire();
    w.childRepo.child = makeActiveThenArchivedChild();
    w.invoiceRepo.current = makeInvoice(periodStart, periodEnd);
    // No payment in paymentRepo — parent hasn't paid the current invoice.

    const result = await w.processor.process(
      makeJob({
        kindergartenId: KG,
        childId: CHILD,
        archivedAt: archivedAt.toISOString(),
      }),
    );

    expect(result).toEqual({
      kind: 'skipped',
      reason: 'no_payment_on_invoice',
    });
    expect(w.refundRepo.refunds).toHaveLength(0);
  });

  it('idempotency: skips when a prior pro-rata refund exists for the child', async () => {
    const w = wire();
    w.childRepo.child = makeActiveThenArchivedChild();
    w.invoiceRepo.current = makeInvoice(periodStart, periodEnd);
    w.refundRepo.preExistingProRata = [
      Refund.fromState({
        id: 'existing-r',
        kindergartenId: KG,
        paymentId: PAYMENT,
        invoiceId: INVOICE,
        amount: MoneyKzt.fromKzt(30000),
        reason: PRO_RATA_REFUND_REASON,
        status: 'pending',
        processedBy: null,
        providerRef: null,
        createdAt: archivedAt,
        updatedAt: archivedAt,
      }),
    ];

    const result = await w.processor.process(
      makeJob({
        kindergartenId: KG,
        childId: CHILD,
        archivedAt: archivedAt.toISOString(),
      }),
    );

    expect(result).toEqual({
      kind: 'skipped',
      reason: 'refund_already_exists',
    });
    expect(w.refundRepo.refunds).toHaveLength(0);
  });

  it('skips when the child is not archived outside the commit-grace window (orphan job)', async () => {
    // Child is still active — archive TX rolled back, BullMQ job is orphan.
    // To distinguish from the in-grace race case, set the clock well past
    // archivedAt + PRO_RATA_COMMIT_GRACE_MS so the processor treats it as
    // a permanent skip (not retryable).
    const lateClock = new FixedClock(
      new Date(archivedAt.getTime() + PRO_RATA_COMMIT_GRACE_MS + 1_000),
    );
    const refundRepo = new FakeRefundRepo();
    const invoiceRepo = new FakeInvoiceRepo();
    const holidayRepo = new FakeHolidayRepo();
    const paymentRepo = new FakePaymentRepo();
    const childRepo = new FakeChildRepo();
    const processor = new ProRataRefundProcessor(
      refundRepo,
      invoiceRepo,
      holidayRepo,
      paymentRepo,
      childRepo,
      lateClock,
      fakeDataSource,
    );

    const active = Child.createNew({
      id: ChildId.parse(CHILD),
      kindergartenId: KindergartenId.parse(KG),
      fullName: 'Айгерим',
      dateOfBirth: new Date('2021-09-15'),
      now: new Date('2026-04-01T00:00:00.000Z'),
    });
    active.activate(new Date('2026-04-01T00:00:00.000Z'));
    childRepo.child = active;
    invoiceRepo.current = makeInvoice(periodStart, periodEnd);

    const result = await processor.process(
      makeJob({
        kindergartenId: KG,
        childId: CHILD,
        archivedAt: archivedAt.toISOString(),
      }),
    );

    expect(result).toEqual({ kind: 'skipped', reason: 'child_not_archived' });
    expect(refundRepo.refunds).toHaveLength(0);
  });

  it('throws ChildNotYetArchivedError when the child is not yet archived within the grace window (retryable race)', async () => {
    const w = wire();
    // Clock is exactly at archivedAt — gapMs = 0, well inside grace. The
    // worker observed an uncommitted producer TX; throw so BullMQ retries.
    const active = Child.createNew({
      id: ChildId.parse(CHILD),
      kindergartenId: KindergartenId.parse(KG),
      fullName: 'Айгерим',
      dateOfBirth: new Date('2021-09-15'),
      now: new Date('2026-04-01T00:00:00.000Z'),
    });
    active.activate(new Date('2026-04-01T00:00:00.000Z'));
    w.childRepo.child = active;
    w.invoiceRepo.current = makeInvoice(periodStart, periodEnd);

    await expect(
      w.processor.process(
        makeJob({
          kindergartenId: KG,
          childId: CHILD,
          archivedAt: archivedAt.toISOString(),
        }),
      ),
    ).rejects.toBeInstanceOf(ChildNotYetArchivedError);
    expect(w.refundRepo.refunds).toHaveLength(0);
  });

  it('skips when no current invoice exists in the archive period', async () => {
    const w = wire();
    w.childRepo.child = makeActiveThenArchivedChild();
    w.invoiceRepo.current = null;

    const result = await w.processor.process(
      makeJob({
        kindergartenId: KG,
        childId: CHILD,
        archivedAt: archivedAt.toISOString(),
      }),
    );

    expect(result).toEqual({ kind: 'skipped', reason: 'no_current_invoice' });
    expect(w.refundRepo.refunds).toHaveLength(0);
  });

  it('respects non-billable holidays when computing the refund', async () => {
    const w = wire();
    w.childRepo.child = makeActiveThenArchivedChild();
    w.invoiceRepo.current = makeInvoice(periodStart, periodEnd);
    w.paymentRepo.paymentsByInvoiceId.set(INVOICE, [
      makeCompletedPayment(INVOICE),
    ]);
    // Two non-billable holidays AFTER the archive day (2026-06-15)
    // — drops refundable billable days from 15 to 13. Total billable
    // days drops from 30 to 28. Refund = 60000 * 13/28 ≈ 27857.14 → 27857.14.
    w.holidayRepo.nonBillableDays.add('2026-06-20');
    w.holidayRepo.nonBillableDays.add('2026-06-25');

    const result = await w.processor.process(
      makeJob({
        kindergartenId: KG,
        childId: CHILD,
        archivedAt: archivedAt.toISOString(),
      }),
    );

    expect(result.kind).toBe('created');
    if (result.kind === 'created') {
      // MoneyKzt fluent chain rounds to 2dp via banker's rounding.
      expect(result.amountKzt).toBeCloseTo(27857.14, 2);
    }
  });

  it('skips when archive falls on the last billable day (refundableDays=0)', async () => {
    const w = wire();
    w.childRepo.child = makeActiveThenArchivedChild();
    // Period 2026-06-01..2026-06-15, archive on 2026-06-15 → archivedDays=15,
    // refundableDays=0 → computed_amount_zero_or_negative.
    w.invoiceRepo.current = makeInvoice(periodStart, archivedAt);

    const result = await w.processor.process(
      makeJob({
        kindergartenId: KG,
        childId: CHILD,
        archivedAt: archivedAt.toISOString(),
      }),
    );

    expect(result).toEqual({
      kind: 'skipped',
      reason: 'computed_amount_zero_or_negative',
    });
  });

  // ── B21 T8 H3 — archive→reactivate→archive double refund ─────────────
  it('creates a second refund for archive→reactivate→archive cycle (different archivedAt)', async () => {
    const w = wire();
    w.childRepo.child = makeActiveThenArchivedChild();
    w.invoiceRepo.current = makeInvoice(periodStart, periodEnd);
    w.paymentRepo.paymentsByInvoiceId.set(INVOICE, [
      makeCompletedPayment(INVOICE),
    ]);

    // First archive on 2026-06-15 → creates the first refund.
    const firstArchivedAt = new Date('2026-06-15T09:00:00.000Z');
    const first = await w.processor.process(
      makeJob({
        kindergartenId: KG,
        childId: CHILD,
        archivedAt: firstArchivedAt.toISOString(),
      }),
    );
    expect(first.kind).toBe('created');
    expect(w.refundRepo.refunds).toHaveLength(1);

    // Simulate reactivate + re-archive on 2026-06-20 — the second
    // archive's `since` window (20th) is past the first refund's
    // createdAt (15th), so the idempotency check correctly does NOT
    // see the prior refund and the processor writes a second one.
    // Seed the first refund into `preExistingProRata` to model the DB
    // state visible at job time.
    w.refundRepo.preExistingProRata = [...w.refundRepo.refunds];

    const secondArchivedAt = new Date('2026-06-20T09:00:00.000Z');
    // Re-archive the child (status was reset to active → archived
    // again at the new timestamp).
    const c2 = makeActiveThenArchivedChild();
    c2.reactivate(secondArchivedAt, 'staff-2');
    c2.archive(secondArchivedAt, 'second archive', 'staff-1');
    w.childRepo.child = c2;
    // Bump the clock so the in-grace branch doesn't fire for the
    // second archive — we want to assert the create path.
    const lateClock = new FixedClock(secondArchivedAt);
    const reprocessor = new ProRataRefundProcessor(
      w.refundRepo,
      w.invoiceRepo,
      w.holidayRepo,
      w.paymentRepo,
      w.childRepo,
      lateClock,
      fakeDataSource,
    );

    const second = await reprocessor.process(
      makeJob({
        kindergartenId: KG,
        childId: CHILD,
        archivedAt: secondArchivedAt.toISOString(),
      }),
    );

    expect(second.kind).toBe('created');
    expect(w.refundRepo.refunds).toHaveLength(2);
  });

  // ── B21 T8 C2 boundary — pro-rata math policy ──────────────────────
  //
  // Code currently treats `archivedDays` as inclusive of the archive
  // day, so `refundableDays = total - archivedDays` excludes that day
  // from the refund. In policy terms: "the archive day is billed; the
  // refund covers (archive_day, period_end]". These boundary tests pin
  // that policy with named numbers; if a product policy change flips
  // semantics, these expectations are the bright line to flip too.
  // See docs/Shyraq BP.md §12.7 (B21 carry-forward note).
  it('boundary: archive on the first day of the period refunds (totalBillable - 1) days', () => {
    // The processor unit math: totalDays=30, archivedDays=1, refund=
    // 60000 * 29/30 = 58000. Asserted via the public happy-path.
    const w = wire();
    w.childRepo.child = makeActiveThenArchivedChild();
    w.invoiceRepo.current = makeInvoice(periodStart, periodEnd);
    w.paymentRepo.paymentsByInvoiceId.set(INVOICE, [
      makeCompletedPayment(INVOICE),
    ]);

    return w.processor
      .process(
        makeJob({
          kindergartenId: KG,
          childId: CHILD,
          archivedAt: new Date('2026-06-01T03:00:00.000Z').toISOString(),
        }),
      )
      .then((result) => {
        expect(result.kind).toBe('created');
        if (result.kind === 'created') {
          // 60000 * 29 / 30 = 58000.
          expect(result.amountKzt).toBe(58000);
        }
      });
  });

  it('boundary: archive on the last day of the period yields 0 refundable days', async () => {
    const w = wire();
    w.childRepo.child = makeActiveThenArchivedChild();
    // periodEnd inclusive at 2026-06-30. Archive on 2026-06-30 →
    // archivedDays=30, refundableDays=0 → skip.
    w.invoiceRepo.current = makeInvoice(periodStart, periodEnd);
    w.paymentRepo.paymentsByInvoiceId.set(INVOICE, [
      makeCompletedPayment(INVOICE),
    ]);

    const result = await w.processor.process(
      makeJob({
        kindergartenId: KG,
        childId: CHILD,
        archivedAt: new Date('2026-06-30T20:00:00.000Z').toISOString(),
      }),
    );
    expect(result).toEqual({
      kind: 'skipped',
      reason: 'computed_amount_zero_or_negative',
    });
  });

  it('ignores jobs with an unknown name (single-queue multi-job design)', async () => {
    const w = wire();
    w.childRepo.child = makeActiveThenArchivedChild();
    w.invoiceRepo.current = makeInvoice(periodStart, periodEnd);

    const job = {
      name: 'lifecycle:other-future-job',
      data: {
        kindergartenId: KG,
        childId: CHILD,
        archivedAt: archivedAt.toISOString(),
      },
    } as unknown as Job<ProRataRefundJobData>;

    const result = await w.processor.process(job);
    expect(result.kind).toBe('skipped');
    expect(w.refundRepo.refunds).toHaveLength(0);
  });
});
