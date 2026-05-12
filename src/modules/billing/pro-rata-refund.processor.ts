import { Inject, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { ChildRepository } from '@/modules/child/infrastructure/persistence/child.repository';
import {
  LIFECYCLE_PRO_RATA_REFUND_JOB,
  LIFECYCLE_QUEUE,
  ProRataRefundJobData,
} from '@/modules/child/lifecycle-queue.constants';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import {
  KG_DEFAULT_TIMEZONE,
  startOfDayInTimezone,
} from '@/shared-kernel/domain/value-objects/day-of-week.vo';
import { roundKzt } from '@/shared-kernel/domain/money';
import { Refund } from './domain/entities/refund.entity';
import { ChildNotYetArchivedError } from './domain/errors/child-not-yet-archived.error';
import { InvoiceRepository } from './infrastructure/persistence/invoice.repository';
import { KindergartenHolidayRepository } from './infrastructure/persistence/kindergarten-holiday.repository';
import { PaymentRepository } from './infrastructure/persistence/payment.repository';
import { RefundRepository } from './infrastructure/persistence/refund.repository';

/**
 * Grace window (ms) during which a `child_not_archived` re-check is
 * treated as a producer-TX-not-yet-committed race rather than a permanent
 * skip. Within this window the worker throws a retryable error so
 * BullMQ's exp-backoff retries the job after the producer TX commits.
 *
 * The producer also wires `delay: PRODUCER_DELAY_MS` (see
 * `child.service.ts`), so under normal conditions the job is not picked
 * up until ~5s after the archive call returned. The 60s grace combined
 * with BullMQ's 3-attempt retry at 1m / 2m / 4m means the worker keeps
 * retrying for up to ~7m before giving up — long enough to weather any
 * realistic commit delay or replica lag.
 */
export const PRO_RATA_COMMIT_GRACE_MS = 60_000;

/**
 * Sentinel reason string written into `refunds.reason` for rows created
 * by this processor. The idempotency check filters strictly on this
 * string so an admin-created refund on the same invoice does not get
 * mistaken for a prior automated run.
 */
export const PRO_RATA_REFUND_REASON = 'pro_rata_archive';

/**
 * Per-job execution outcome. The processor returns one of these so the
 * BullMQ job result is queryable + so the integration race spec can
 * assert on the discriminator without re-querying the DB.
 */
export type ProRataRefundOutcome =
  | { kind: 'created'; refundId: string; amountKzt: number; invoiceId: string }
  | { kind: 'skipped'; reason: ProRataSkipReason };

export type ProRataSkipReason =
  | 'child_not_archived'
  | 'refund_already_exists'
  | 'no_current_invoice'
  | 'no_billable_days_after_archive'
  | 'computed_amount_zero_or_negative'
  | 'no_payment_on_invoice';

/**
 * ProRataRefundProcessor — BullMQ worker that creates the pro-rata refund
 * row for a freshly-archived child (B21 T3 step 4).
 *
 * Trigger:
 *   `ChildService.archive` enqueues `lifecycle:pro-rata-refund` on the
 *   `lifecycle` queue with `{ kindergartenId, childId, archivedAt }`.
 *   BullMQ retry config (set by the producer) is 3 attempts with
 *   exp-backoff 1m/2m/4m.
 *
 * Per-tick flow:
 *   1. Open ITS OWN transaction (the producer's TX has long since
 *      committed by the time BullMQ delivers the job). Set the kg
 *      RLS GUC inside the TX, then publish via `tenantStorage.run` so
 *      repositories pick up the per-tx manager.
 *   2. Acquire the per-child advisory lock so two concurrent worker
 *      processes (or replay attempts within the BullMQ retry window)
 *      don't both insert refund rows.
 *   3. Re-check that the child is still `status='archived'` — the
 *      archive could have been rolled back inside the producer TX (rare
 *      but possible). If not archived, skip (the producer's TX did NOT
 *      commit; the BullMQ job is an orphan).
 *   4. Idempotency: scan `refunds` (joined to invoices.child_id) for a
 *      row with `reason='pro_rata_archive'` created on/after the
 *      archive moment. If found, skip — a prior attempt of this job
 *      already wrote the refund.
 *   5. Resolve the current invoice (period containing `archivedAt`,
 *      status pending|partial|overdue). If none, skip — there's
 *      nothing to refund (e.g. child archived before the monthly cron
 *      ran for the current period).
 *   6. Compute billable days in the period minus non-billable holidays.
 *      Compute archived-side billable days (start..archivedAt
 *      inclusive). Refundable days = totalBillable - archivedBillable.
 *      refundAmount = roundKzt(invoice.amountAfterDiscount *
 *      refundableDays / totalBillableDays). If <= 0, skip (archive
 *      landed on the last billable day — nothing to refund).
 *   7. INSERT a new refund row with status='pending', the sentinel
 *      reason, and the computed amount. `payment_id` is set to the
 *      invoice's pre-existing payment_id when one exists; otherwise the
 *      processor falls back to inserting with `payment_id` pointing at
 *      a sentinel (current schema forces a non-null payment_id on the
 *      refund). The post-archive admin workflow approves + processes
 *      the row via `RefundService` in B21 T5+.
 *
 * Note (B21 T3 carry-forward to T6): the refunds table currently
 * requires a non-null `payment_id`. A child can be archived without
 * having a payment yet on the current invoice (parent hasn't paid for
 * the current period). For now the processor skips when no payment
 * exists; T6 will decide whether to relax the schema or carry a
 * pre-issued-refund concept. The current behaviour is conservative —
 * better to skip than to bind the refund to a payment that doesn't
 * cover it.
 */
@Processor(LIFECYCLE_QUEUE)
export class ProRataRefundProcessor extends WorkerHost {
  private readonly logger = new Logger(ProRataRefundProcessor.name);

  constructor(
    private readonly refundRepo: RefundRepository,
    private readonly invoiceRepo: InvoiceRepository,
    private readonly holidayRepo: KindergartenHolidayRepository,
    private readonly paymentRepo: PaymentRepository,
    @Inject(ChildRepository) private readonly childRepo: ChildRepository,
    @Inject(ClockPort) private readonly clock: ClockPort,
    private readonly dataSource: DataSource,
  ) {
    super();
  }

  async process(job: Job<ProRataRefundJobData>): Promise<ProRataRefundOutcome> {
    if (job.name !== LIFECYCLE_PRO_RATA_REFUND_JOB) {
      // Single-queue, multi-job-name design — silently ignore unknown
      // jobs so the same worker can host additional lifecycle handlers
      // without each one repeating the dispatch boilerplate.
      return { kind: 'skipped', reason: 'child_not_archived' };
    }
    const { kindergartenId, childId, archivedAt } = job.data;
    const archivedAtDate = new Date(archivedAt);

    this.logger.log(
      `pro-rata-refund start: kg=${kindergartenId} child=${childId} archivedAt=${archivedAt}`,
    );

    return this.runForChild(kindergartenId, childId, archivedAtDate);
  }

  /**
   * Exposed (not `private`) so the integration race spec can drive the
   * processor directly without going through BullMQ.
   */
  async runForChild(
    kindergartenId: string,
    childId: string,
    archivedAt: Date,
  ): Promise<ProRataRefundOutcome> {
    return this.dataSource.transaction(async (em) => {
      // Set the kg-scoped RLS GUC so repositories see only this tenant.
      // The repo `manager()` helpers resolve to this entityManager via
      // tenantStorage.
      await em.query(`SELECT set_config('app.kindergarten_id', $1, true)`, [
        kindergartenId,
      ]);
      return tenantStorage.run(
        { kgId: kindergartenId, bypass: false, entityManager: em },
        () => this.computeAndCreate(kindergartenId, childId, archivedAt),
      );
    });
  }

  private async computeAndCreate(
    kindergartenId: string,
    childId: string,
    archivedAt: Date,
  ): Promise<ProRataRefundOutcome> {
    // Step 2: advisory lock — serialise concurrent runs.
    await this.refundRepo.acquireProRataAdvisoryLock(kindergartenId, childId);

    // Step 3: re-check the archive landed.
    //
    // Two sub-cases when the child is not yet observed as archived:
    //   (a) Producer's PG TX has not committed yet — BullMQ delivered
    //       Redis-side before the row materialised. We throw a
    //       retryable error so BullMQ retries under exp-backoff; by the
    //       next attempt the commit is almost certainly visible. The
    //       producer also wires `delay: 5s` which makes this branch
    //       rarely fire in practice (see ChildService.archiveChild).
    //   (b) Producer's TX actually rolled back (e.g. close-tariff
    //       failed after the conditional UPDATE returned a row). The
    //       BullMQ job is an orphan — skip permanently so it doesn't
    //       block the retry slot. We distinguish (a) vs (b) by the gap
    //       between `archivedAt` (from the job payload) and `now()`:
    //       within `PRO_RATA_COMMIT_GRACE_MS` it is (a); outside it is
    //       (b). The grace window is generous (60s) so replica lag or
    //       long-running close-tariff transactions don't hit the
    //       permanent-skip branch.
    const child = await this.childRepo.findById(kindergartenId, childId);
    if (!child || child.status.value !== 'archived') {
      const observedStatus = child?.status.value ?? 'absent';
      const gapMs = Math.max(
        0,
        this.clock.now().getTime() - archivedAt.getTime(),
      );
      if (gapMs < PRO_RATA_COMMIT_GRACE_MS) {
        this.logger.warn(
          `pro-rata-refund retry child_not_yet_archived kg=${kindergartenId} child=${childId} observed=${observedStatus} gapMs=${gapMs}`,
        );
        throw new ChildNotYetArchivedError(childId, observedStatus);
      }
      this.logger.warn(
        `pro-rata-refund skip child_not_archived kg=${kindergartenId} child=${childId} observed=${observedStatus} gapMs=${gapMs}`,
      );
      return { kind: 'skipped', reason: 'child_not_archived' };
    }

    // Step 4: idempotency.
    const existing =
      await this.refundRepo.findPendingProRataForChildSinceArchive(
        kindergartenId,
        childId,
        archivedAt,
      );
    if (existing.length > 0) {
      this.logger.log(
        `pro-rata-refund skip refund_already_exists kg=${kindergartenId} child=${childId} existing=${existing[0].id}`,
      );
      return { kind: 'skipped', reason: 'refund_already_exists' };
    }

    // Step 5: resolve current invoice.
    const invoice = await this.invoiceRepo.findCurrentInvoiceForChildAt(
      kindergartenId,
      childId,
      archivedAt,
    );
    if (!invoice) {
      this.logger.warn(
        `pro-rata-refund skip no_current_invoice kg=${kindergartenId} child=${childId} at=${archivedAt.toISOString()}`,
      );
      return { kind: 'skipped', reason: 'no_current_invoice' };
    }

    // Step 6: compute billable days + refundable amount.
    const { totalBillableDays, refundableDays } =
      await this.computeBillableDays(
        kindergartenId,
        invoice.periodStart,
        invoice.periodEnd,
        archivedAt,
      );

    if (totalBillableDays <= 0) {
      this.logger.warn(
        `pro-rata-refund skip no_billable_days_after_archive kg=${kindergartenId} child=${childId}`,
      );
      return {
        kind: 'skipped',
        reason: 'no_billable_days_after_archive',
      };
    }

    // Single-step rounding: `(amount * refundableDays) / totalBillableDays`
    // then round to 2dp. Intermediate division through divideKzt would
    // round to 2dp before re-multiplying, accumulating "double-rounding"
    // loss of up to ~half a tiyn per ₸ of amount. The proportion math
    // must round exactly once, at the end, so we call `roundKzt` on the
    // composed expression rather than chaining `multiplyKzt`/`divideKzt`.
    const refundAmount = roundKzt(
      (invoice.amountAfterDiscount * refundableDays) / totalBillableDays,
    );
    if (refundAmount <= 0) {
      this.logger.log(
        `pro-rata-refund skip computed_amount_zero_or_negative kg=${kindergartenId} child=${childId} amount=${refundAmount}`,
      );
      return { kind: 'skipped', reason: 'computed_amount_zero_or_negative' };
    }

    // Step 7: resolve a payment to attach the refund to. The refunds
    // table requires non-null payment_id (FK to payments). The MVP
    // semantics are: refund the parent's most recent completed payment
    // on this invoice. When no payment exists yet (parent hasn't paid
    // the current invoice), skip — the admin will surface a refund
    // manually after the parent pays. T6 may relax this (issue a
    // "preliminary refund" concept) but B21 stays conservative.
    const payments = await this.paymentRepo.findByInvoiceId(
      kindergartenId,
      invoice.id,
    );
    const targetPayment = payments.find((p) => p.status === 'completed');
    if (!targetPayment) {
      this.logger.log(
        `pro-rata-refund skip no_payment_on_invoice kg=${kindergartenId} child=${childId} invoice=${invoice.id}`,
      );
      return { kind: 'skipped', reason: 'no_payment_on_invoice' };
    }

    const refundId = randomUUID();
    const now = this.clock.now();
    const refund = Refund.fromState({
      id: refundId,
      kindergartenId,
      paymentId: targetPayment.id,
      invoiceId: invoice.id,
      amount: refundAmount,
      reason: PRO_RATA_REFUND_REASON,
      status: 'pending',
      processedBy: null,
      providerRef: null,
      createdAt: now,
      updatedAt: now,
    });

    await this.refundRepo.create(refund);

    this.logger.log(
      `pro-rata-refund created kg=${kindergartenId} child=${childId} invoice=${invoice.id} refund=${refundId} amount=${refundAmount} (refundableDays=${refundableDays}/${totalBillableDays})`,
    );

    return {
      kind: 'created',
      refundId,
      amountKzt: refundAmount,
      invoiceId: invoice.id,
    };
  }

  /**
   * Compute billable days in the period minus non-billable holidays.
   * Anchored in Asia/Almaty TZ (per B12 default) so a child archived
   * near local midnight does not see a UTC-day skew.
   *
   * Logic:
   *   - `totalDaysInPeriod` = inclusive day count between periodStart
   *     and periodEnd.
   *   - `nonBillableHolidays` = count of holidays.is_billable=false
   *     within [periodStart, periodEnd].
   *   - `totalBillableDays` = totalDaysInPeriod - nonBillableHolidays.
   *   - `archivedBillableDays` = billable days from periodStart
   *     up-to-and-including the archive day (Asia/Almaty).
   *   - `refundableDays` = totalBillableDays - archivedBillableDays.
   *
   * **Archive-day billing policy (B21 carry-forward):** because
   * `archivedBillableDays` counts the archive day INCLUSIVELY, the refund
   * window is effectively `(archive_day, period_end]` — the kindergarten
   * keeps payment for the day the child was archived. Boundary tests in
   * `pro-rata-refund.processor.spec.ts` pin this with named numbers
   * (archive on day 1 → refund 29/30 of amount; archive on last day →
   * refund 0). Product confirmation required — see
   * `IMPLEMENTATION_PLAN.md §5 Active` (B21 T6/T7 carry-forwards).
   */
  private async computeBillableDays(
    kindergartenId: string,
    periodStart: Date,
    periodEnd: Date,
    archivedAt: Date,
  ): Promise<{ totalBillableDays: number; refundableDays: number }> {
    const startLocal = startOfDayInTimezone(periodStart, KG_DEFAULT_TIMEZONE);
    const endLocal = startOfDayInTimezone(periodEnd, KG_DEFAULT_TIMEZONE);
    const archivedLocal = startOfDayInTimezone(archivedAt, KG_DEFAULT_TIMEZONE);

    const dayMs = 24 * 60 * 60 * 1000;
    const totalDays =
      Math.round((endLocal.getTime() - startLocal.getTime()) / dayMs) + 1;
    // archivedDays = days from start to archive INCLUSIVE.
    const rawArchivedDays =
      Math.round((archivedLocal.getTime() - startLocal.getTime()) / dayMs) + 1;
    const archivedDays = Math.max(0, Math.min(totalDays, rawArchivedDays));

    const nonBillableTotal = await this.holidayRepo.countNonBillableInRange(
      kindergartenId,
      startLocal,
      endLocal,
    );
    const nonBillableBeforeArchive =
      archivedDays > 0
        ? await this.holidayRepo.countNonBillableInRange(
            kindergartenId,
            startLocal,
            archivedLocal,
          )
        : 0;

    const totalBillableDays = Math.max(0, totalDays - nonBillableTotal);
    const archivedBillableDays = Math.max(
      0,
      archivedDays - nonBillableBeforeArchive,
    );
    const refundableDays = Math.max(
      0,
      totalBillableDays - archivedBillableDays,
    );

    return { totalBillableDays, refundableDays };
  }
}
