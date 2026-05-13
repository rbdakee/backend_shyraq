import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { NotificationPort } from '@/common/notifications/notification.port';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { ChildRepository } from '@/modules/child/infrastructure/persistence/child.repository';
import { ChildGuardianRepository } from '@/modules/child/infrastructure/persistence/child-guardian.repository';
import {
  Invoice,
  InvoiceState,
  InvoiceStatus,
  InvoiceType,
} from './domain/entities/invoice.entity';
import {
  InvoiceLineItem,
  InvoiceLineItemState,
} from './domain/entities/invoice-line-item.entity';
import { Payment, PaymentState } from './domain/entities/payment.entity';
import { TariffPlan } from './domain/entities/tariff-plan.entity';
import { TariffAssignment } from './domain/entities/tariff-assignment.entity';
import { ChildArchivedDuringRunError } from './domain/errors/child-archived-during-run.error';
import { InvoiceAlreadyPaidError } from './domain/errors/invoice-already-paid.error';
import { InvoiceNotFoundError } from './domain/errors/invoice-not-found.error';
import { InvoiceStatusInvalidError } from './domain/errors/invoice-status-invalid.error';
import { TariffAssignmentNotFoundError } from './domain/errors/tariff-assignment-not-found.error';
import { TariffPlanNotFoundError } from './domain/errors/tariff-plan-not-found.error';
import {
  CustomDiscountSnapshot,
  DiscountEnginePort,
  DiscountEvaluationInput,
  DiscountEvaluationResult,
} from './infrastructure/discount-engine/discount-engine.port';
import { CustomDiscountRepository } from './custom-discount.repository';
import { CustomDiscountApplicationRepository } from './custom-discount-application.repository';
import { DiscountTargetResolver } from './discount-target-resolver';
import { CustomDiscount } from './domain/entities/custom-discount.entity';
import {
  InvoiceRepository,
  ListInvoicesFilter,
} from './infrastructure/persistence/invoice.repository';
import { InvoiceLineItemRepository } from './infrastructure/persistence/invoice-line-item.repository';
import { PaymentRepository } from './infrastructure/persistence/payment.repository';
import { TariffAssignmentRepository } from './infrastructure/persistence/tariff-assignment.repository';
import { TariffPlanRepository } from './infrastructure/persistence/tariff-plan.repository';
import { HolidayService } from './holiday.service';
import { PaymentAccountService } from './payment-account.service';
import { MoneyKzt } from '@/shared-kernel/domain/money-kzt';
import { firstOfMonthInTimezone } from '@/shared-kernel/domain/value-objects/day-of-week.vo';

const DEFAULT_DUE_DAY = 10; // monthly invoices fall due on the 10th of period
const LATE_PICKUP_DUE_DAYS = 7;

export interface CreateOneOffInvoiceInput {
  childId: string;
  invoiceType: InvoiceType;
  amountDue: number;
  dueDate: Date;
  periodStart: Date;
  periodEnd: Date;
  description?: string | null;
  lineItems?: Array<{
    description: string;
    quantity: number;
    unitPrice: number;
    tariffPlanId?: string | null;
  }>;
  discountPct?: number | null;
  discountReason?: string | null;
  tariffPlanId?: string | null;
}

export interface ManualMarkPaidInput {
  paidAt?: Date;
  payerUserId?: string | null;
  note?: string | null;
}

export interface GenerateMonthlyResult {
  generated: number;
  skipped: number;
}

export interface GenerateFirstInvoiceInput {
  childId: string;
  enrollmentDate: Date;
  assignedBy: string;
}

export interface GenerateLatePickupInvoiceInput {
  childId: string;
  parentRequestId: string;
  expectedTime: string;
  actualTime: string;
  date: Date;
  requestedBy: string;
  /** Fallback if no active `late_pickup_fee` plan is found. */
  lateFeeAmountKzt?: number;
}

/**
 * Internal shape for `buildPaymentCalendar`. Fields are snake_case so the
 * controller can return the array verbatim under `PaymentCalendarResponseDto`.
 */
export interface PaymentCalendarMonthEntry {
  period_start: string;
  period_end: string;
  invoice_id: string | null;
  projected_status:
    | 'pending'
    | 'paid'
    | 'overdue'
    | 'partial'
    | 'projected'
    | 'refunded'
    | 'cancelled';
  amount_after_discount: number | null;
  due_date: string | null;
  is_projection: boolean;
  holidays_affected: number;
}

/**
 * InvoiceService — admin/internal CRUD plus the auto-generation entry
 * points used by the monthly cron (T4b) and cross-module hooks (T4c).
 *
 * State-flip transitions (`manualMarkPaid`, `cancel`) use the
 * conditional-UPDATE-WHERE-status pattern (db8cb72) for race-safety —
 * the repo returns `null` when the row is in an unexpected state, which
 * is mapped to `InvoiceStatusInvalidError` (or `InvoiceAlreadyPaidError`
 * after a follow-up read disambiguates).
 *
 * Caller responsibilities:
 *   - HTTP path: ambient TX is provided by `TenantContextInterceptor`. The
 *     service relies on `tenantStorage` for the EM and does not open an
 *     inner TX.
 *   - Cron / outbox path (`generateMonthly` callers): caller MUST wrap the
 *     invocation in `dataSource.transaction(em => tenantStorage.run(
 *     {kgId, entityManager: em, bypass: false}, () => invoice.service....))
 *     so `acquireMonthlyGenerationAdvisoryLock` is held for the duration
 *     of the generation work and released at TX commit.
 */
@Injectable()
export class InvoiceService {
  private readonly logger = new Logger(InvoiceService.name);

  constructor(
    private readonly invoices: InvoiceRepository,
    private readonly invoiceLineItems: InvoiceLineItemRepository,
    private readonly tariffPlans: TariffPlanRepository,
    private readonly tariffAssignments: TariffAssignmentRepository,
    private readonly paymentAccounts: PaymentAccountService,
    @Inject(DiscountEnginePort)
    private readonly discountEngine: DiscountEnginePort,
    private readonly holidays: HolidayService,
    private readonly notificationPort: NotificationPort,
    @Inject(ClockPort) private readonly clock: ClockPort,
    private readonly payments: PaymentRepository,
    // ── B16 deps (optional at runtime — InvoiceService instances built by
    //    older integration specs without B16 wiring keep working with
    //    `undefined` here; the service short-circuits the custom-discount
    //    flow when any of these are missing.)
    private readonly customDiscounts?: CustomDiscountRepository,
    private readonly customDiscountApplications?: CustomDiscountApplicationRepository,
    private readonly discountTargetResolver?: DiscountTargetResolver,
    private readonly children?: ChildRepository,
    private readonly childGuardians?: ChildGuardianRepository,
  ) {}

  // ── CRUD ───────────────────────────────────────────────────────────────

  async list(
    kindergartenId: string,
    filter: ListInvoicesFilter = {},
  ): Promise<Invoice[]> {
    return this.invoices.list(kindergartenId, filter);
  }

  async get(kindergartenId: string, id: string): Promise<Invoice> {
    const invoice = await this.invoices.findById(kindergartenId, id);
    if (!invoice) {
      throw new InvoiceNotFoundError(id);
    }
    return invoice;
  }

  async listLineItems(
    kindergartenId: string,
    invoiceId: string,
  ): Promise<InvoiceLineItem[]> {
    return this.invoiceLineItems.listByInvoice(kindergartenId, invoiceId);
  }

  // ── Admin one-off ──────────────────────────────────────────────────────

  async createOneOff(
    kindergartenId: string,
    input: CreateOneOffInvoiceInput,
  ): Promise<Invoice> {
    const now = this.clock.now();
    const account = await this.paymentAccounts.ensureForChild(
      kindergartenId,
      input.childId,
    );
    const amountDue = MoneyKzt.fromKzt(input.amountDue);
    const discountPct = input.discountPct ?? null;
    const amountAfter = Invoice.computeAmountAfterDiscount(
      amountDue,
      discountPct,
    );
    const invoiceId = randomUUID();
    const state: InvoiceState = {
      id: invoiceId,
      kindergartenId,
      childId: input.childId,
      paymentAccountId: account.id,
      tariffPlanId: input.tariffPlanId ?? null,
      invoiceType: input.invoiceType,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      amountDue,
      discountPct,
      discountReason: input.discountReason ?? null,
      amountAfterDiscount: amountAfter,
      status: 'pending',
      dueDate: input.dueDate,
      description: input.description ?? null,
      proratedForDays: null,
      createdAt: now,
      updatedAt: now,
    };
    const invoice = Invoice.fromState(state);

    const lineItems: InvoiceLineItem[] = (input.lineItems ?? []).map((li) => {
      const unitPriceMk = MoneyKzt.fromKzt(li.unitPrice);
      return InvoiceLineItem.fromState({
        id: randomUUID(),
        invoiceId,
        kindergartenId,
        description: li.description,
        tariffPlanId: li.tariffPlanId ?? null,
        quantity: li.quantity,
        unitPrice: unitPriceMk,
        lineTotal: InvoiceLineItem.compute(li.quantity, unitPriceMk),
        createdAt: now,
      });
    });

    const persisted = await this.invoices.create(invoice, lineItems);
    await this.emitInvoiceCreated(persisted);
    return persisted;
  }

  // ── Admin actions (state flips) ────────────────────────────────────────

  /**
   * Records an off-platform (cash) payment as a `Payment` row, credits the
   * payment_account, and flips the invoice to `paid`. Idempotent at the
   * conditional-UPDATE level — a 0-row result is mapped to
   * `InvoiceStatusInvalidError` (or `InvoiceAlreadyPaidError` if a
   * follow-up read shows the row is already `paid`).
   *
   * The synthetic `Payment` row uses `provider='cash'` and a deterministic
   * idempotency key `cash:<invoiceId>:<isoTimestamp>` so reconciliation via
   * `GET /admin/payments` reflects the cash receipt and any subsequent
   * refund flow can target the row (T11 C3).
   */
  async manualMarkPaid(
    kindergartenId: string,
    invoiceId: string,
    input: ManualMarkPaidInput = {},
  ): Promise<Invoice> {
    const now = this.clock.now();
    // Read the residual (amount-after-discount minus existing paid sum)
    // BEFORE flipping the invoice — we'll use it as the synthetic Payment
    // row's amount.
    const existingForResidual = await this.invoices.findById(
      kindergartenId,
      invoiceId,
    );
    if (!existingForResidual) {
      throw new InvoiceNotFoundError(invoiceId);
    }
    const priorPaidSum = MoneyKzt.fromKzt(
      await this.invoices.getPaidSumForInvoice(kindergartenId, invoiceId),
    );
    const residual = existingForResidual.amountAfterDiscount.sub(priorPaidSum);

    const updated = await this.invoices.markPaidConditional(
      kindergartenId,
      invoiceId,
      now,
    );
    if (!updated) {
      const existing = await this.invoices.findById(kindergartenId, invoiceId);
      if (!existing) {
        throw new InvoiceNotFoundError(invoiceId);
      }
      if (existing.status === 'paid') {
        throw new InvoiceAlreadyPaidError(invoiceId);
      }
      throw new InvoiceStatusInvalidError(existing.status, 'manualMarkPaid');
    }

    // T11 C3: synthesise a Payment row with provider='cash'. Without this
    // GET /admin/payments would never show cash receipts, getPaidSumForInvoice
    // would return 0 forever for cash-paid invoices, and the refund flow on
    // those invoices would fail (no payment row to flip → refunded). The
    // Payment row's amount is the residual at the moment of the cash
    // receipt — partial cash payments are not supported (admins are
    // expected to call manualMarkPaid only when full payment was received
    // off-platform), but using the residual rather than amount_after_discount
    // keeps the ledger correct if a partial gateway payment landed earlier.
    const paymentAmount = residual.isPositive()
      ? residual
      : updated.amountAfterDiscount;
    const paidAt = input.paidAt ?? now;
    const cashPayment = Payment.fromState({
      id: randomUUID(),
      kindergartenId,
      invoiceId: updated.id,
      childId: updated.childId,
      payerUserId: input.payerUserId ?? null,
      amount: paymentAmount,
      provider: 'cash',
      providerTxnId: null,
      idempotencyKey: `cash:${updated.id}:${now.toISOString()}`,
      status: 'completed',
      providerPayload: {
        note: input.note ?? null,
        marked_by: 'admin_manual',
      },
      paidAt,
      refundId: null,
      createdAt: now,
      updatedAt: now,
    } as PaymentState);
    await this.payments.create(cashPayment);

    if (residual.isPositive()) {
      await this.paymentAccounts.creditFromPayment(
        kindergartenId,
        updated.paymentAccountId,
        residual,
      );
    }
    await this.notificationPort.notifyPaymentCompleted({
      kindergartenId,
      paymentId: cashPayment.id,
      childId: updated.childId,
      invoiceId: updated.id,
      amount: cashPayment.amount.toNumber(),
      provider: 'cash',
      paidAt,
    });
    await this.notificationPort.notifyInvoicePaid({
      kindergartenId,
      invoiceId: updated.id,
      childId: updated.childId,
      amountAfterDiscount: updated.amountAfterDiscount.toNumber(),
      paidAt,
    });
    return updated;
  }

  async cancel(
    kindergartenId: string,
    invoiceId: string,
    reason?: string,
  ): Promise<Invoice> {
    const now = this.clock.now();
    const updated = await this.invoices.markCancelledConditional(
      kindergartenId,
      invoiceId,
      now,
    );
    if (!updated) {
      const existing = await this.invoices.findById(kindergartenId, invoiceId);
      if (!existing) {
        throw new InvoiceNotFoundError(invoiceId);
      }
      if (existing.status === 'paid') {
        throw new InvoiceAlreadyPaidError(invoiceId);
      }
      throw new InvoiceStatusInvalidError(existing.status, 'cancel');
    }
    await this.notificationPort.notifyInvoiceCancelled({
      kindergartenId,
      invoiceId: updated.id,
      childId: updated.childId,
      reason: reason ?? null,
    });
    return updated;
  }

  // ── Auto-generation ────────────────────────────────────────────────────

  /**
   * Cron-callable. Emits monthly invoices for every active tariff
   * assignment as of `periodStart`. See class-level docstring on the
   * required ambient TX. Idempotent via advisory lock + existsMonthlyForPeriod
   * short-circuit (only `invoice_type='monthly'` rows count — prepayments
   * and one-offs do not block re-runs).
   */
  async generateMonthly(
    kindergartenId: string,
    periodStart: Date,
  ): Promise<GenerateMonthlyResult> {
    await this.invoices.acquireMonthlyGenerationAdvisoryLock(
      kindergartenId,
      periodStart,
    );

    const assignments = await this.tariffAssignments.findAllActiveAtDate(
      kindergartenId,
      periodStart,
    );

    if (assignments.length === 0) {
      return { generated: 0, skipped: 0 };
    }

    if (
      await this.invoices.existsMonthlyForPeriod(kindergartenId, periodStart)
    ) {
      return { generated: 0, skipped: assignments.length };
    }

    const periodEnd = endOfMonth(periodStart);
    const dueDate = new Date(
      Date.UTC(
        periodStart.getUTCFullYear(),
        periodStart.getUTCMonth(),
        DEFAULT_DUE_DAY,
      ),
    );
    const totalDays = daysBetweenInclusive(periodStart, periodEnd);
    const nonBillableHolidays = await this.holidays.countNonBillableInRange(
      kindergartenId,
      periodStart,
      periodEnd,
    );

    let generated = 0;
    let skipped = 0;
    for (const assignment of assignments) {
      // B21 T3 step5: defence-in-depth gate against billing archived
      // children. T3 step3 closes their tariff_assignment at the archive
      // moment via `closeActiveForChild`, so `findAllActiveAtDate` here
      // should already exclude them. The status check below catches the
      // narrow race where archive lands AFTER `periodStart` (the
      // assignment's valid_until still covers periodStart, so it's
      // returned, but the cron tick happens later in the day after the
      // archive committed). Child repo is optional in the constructor —
      // pre-B16 integration specs build InvoiceService without it, so we
      // fall back to no-op when undefined.
      if (this.children) {
        const child = await this.children.findById(
          kindergartenId,
          assignment.childId,
        );
        if (!child || child.status.value === 'archived') {
          this.logger.log(
            `monthly: skipping child=${assignment.childId} — status=${child?.status.value ?? 'missing'}`,
          );
          skipped++;
          continue;
        }
      }

      const tariffPlan = await this.tariffPlans.findById(
        kindergartenId,
        assignment.tariffPlanId,
      );
      if (!tariffPlan) {
        // Misconfigured — log and skip to keep the cron moving rather than
        // poisoning the whole run for one bad assignment.
        this.logger.warn(
          `monthly: skipping child=${assignment.childId} — tariff_plan ${assignment.tariffPlanId} not found`,
        );
        skipped++;
        continue;
      }
      try {
        await this.generateAndPersistInvoice({
          kindergartenId,
          assignment,
          tariffPlan,
          invoiceType: 'monthly',
          periodStart,
          periodEnd,
          dueDate,
          totalDays,
          nonBillableHolidays,
          prepaymentMonths: undefined,
        });
        generated++;
      } catch (err) {
        if (err instanceof ChildArchivedDuringRunError) {
          // FINDINGS B21-T6-M3: archive landed between this loop's
          // top-of-iteration status read and the per-child INSERT TX.
          // The `existsActiveByIdForUpdate` guard inside
          // `generateAndPersistInvoice` aborted the INSERT, so no
          // invoice row exists for this child this period. Count it
          // as skipped (NOT generated, NOT errored) — the cron summary
          // surfaces the count, the inner warn-log captures the
          // forensic detail.
          skipped++;
          continue;
        }
        throw err;
      }
    }

    return { generated, skipped };
  }

  /**
   * Cross-module hook entry — called by T4c on enrollment `card_created`.
   * Throws `TariffAssignmentNotFoundError` if no active assignment covers
   * `enrollmentDate` (caller decides whether to skip silently or surface
   * 404). Pro-rates by remaining days in the enrollment month.
   */
  async generateFirstInvoice(
    kindergartenId: string,
    input: GenerateFirstInvoiceInput,
  ): Promise<Invoice> {
    const assignment = await this.tariffAssignments.findActiveForChild(
      kindergartenId,
      input.childId,
      input.enrollmentDate,
    );
    if (!assignment) {
      throw new TariffAssignmentNotFoundError(input.childId);
    }
    const tariffPlan = await this.tariffPlans.findById(
      kindergartenId,
      assignment.tariffPlanId,
    );
    if (!tariffPlan) {
      throw new TariffPlanNotFoundError(assignment.tariffPlanId);
    }
    // SP2: anchor on Asia/Almaty so an enrollment landing right after
    // local midnight (UTC still previous day) is billed against the new
    // local calendar month, matching `monthly-billing.processor.ts`.
    const periodStart = firstOfMonthInTimezone(input.enrollmentDate);
    const periodEnd = endOfMonth(periodStart);
    const totalDays = daysBetweenInclusive(periodStart, periodEnd);
    const billableDays = daysBetweenInclusive(input.enrollmentDate, periodEnd);
    const nonBillableHolidays = await this.holidays.countNonBillableInRange(
      kindergartenId,
      input.enrollmentDate,
      periodEnd,
    );
    const dueDate = new Date(
      Date.UTC(
        periodStart.getUTCFullYear(),
        periodStart.getUTCMonth(),
        DEFAULT_DUE_DAY,
      ),
    );
    return this.generateAndPersistInvoice({
      kindergartenId,
      assignment,
      tariffPlan,
      invoiceType: 'monthly',
      periodStart: input.enrollmentDate,
      periodEnd,
      dueDate,
      totalDays,
      nonBillableHolidays,
      prepaymentMonths: undefined,
      proratedBillableDays: billableDays,
    });
  }

  /**
   * Cross-module hook entry — called by T4c on parent_request.accept(late_pickup).
   * If no active `late_pickup_fee` tariff plan is configured and `input.lateFeeAmountKzt`
   * is also unset, throws `TariffPlanNotFoundError` so the caller surfaces a
   * misconfiguration error.
   */
  async generateLatePickupInvoice(
    kindergartenId: string,
    input: GenerateLatePickupInvoiceInput,
  ): Promise<Invoice> {
    const now = this.clock.now();
    const tariffPlan = await this.tariffPlans.findActiveByType(
      kindergartenId,
      'late_pickup_fee',
      input.date,
    );
    let amount: MoneyKzt;
    let tariffPlanId: string | null;
    if (tariffPlan) {
      amount = tariffPlan.amount;
      tariffPlanId = tariffPlan.id;
    } else if (input.lateFeeAmountKzt !== undefined) {
      amount = MoneyKzt.fromKzt(input.lateFeeAmountKzt);
      tariffPlanId = null;
    } else {
      throw new TariffPlanNotFoundError('late_pickup_fee');
    }

    const account = await this.paymentAccounts.ensureForChild(
      kindergartenId,
      input.childId,
    );
    const dateIso = input.date.toISOString().slice(0, 10);
    const description = `Late pickup fee — date ${dateIso}, expected ${input.expectedTime}, actual ${input.actualTime}`;
    const dueDate = addDaysUtc(input.date, LATE_PICKUP_DUE_DAYS);
    const invoiceId = randomUUID();
    const invoice = Invoice.fromState({
      id: invoiceId,
      kindergartenId,
      childId: input.childId,
      paymentAccountId: account.id,
      tariffPlanId,
      invoiceType: 'late_pickup_fee',
      periodStart: input.date,
      periodEnd: input.date,
      amountDue: amount,
      discountPct: null,
      discountReason: null,
      amountAfterDiscount: amount,
      status: 'pending',
      dueDate,
      description,
      proratedForDays: null,
      createdAt: now,
      updatedAt: now,
    });
    const lineItem = InvoiceLineItem.fromState({
      id: randomUUID(),
      invoiceId,
      kindergartenId,
      description,
      tariffPlanId,
      quantity: 1,
      unitPrice: amount,
      lineTotal: InvoiceLineItem.compute(1, amount),
      createdAt: now,
    });
    const persisted = await this.invoices.create(invoice, [lineItem]);
    await this.emitInvoiceCreated(persisted);
    return persisted;
  }

  // ── parent-facing read flows ───────────────────────────────────────────

  /**
   * Build the next-N-months payment calendar for a child. Months that
   * already have an invoice surface real data; future months without an
   * invoice yet are returned as `projected` rows derived from the active
   * `tariff_assignment` + holiday count (best-effort estimate).
   *
   * `monthsAhead` is clamped to `[1, 24]`. The starting month is the first
   * day of the current UTC month (DB stores `period_start` as `date`).
   */
  async buildPaymentCalendar(
    kindergartenId: string,
    childId: string,
    monthsAhead: number,
  ): Promise<PaymentCalendarMonthEntry[]> {
    if (monthsAhead < 1 || monthsAhead > 24) {
      throw new BadRequestException('months_ahead_out_of_range');
    }
    const today = this.clock.now();
    // SP2: anchor on Asia/Almaty calendar month — `startOfMonth(today)` under
    // UTC math rolls a month back when called near Almaty midnight (e.g.
    // 2026-05-31T22:00Z = 2026-06-01T03:00 Almaty → June, not May). The
    // `firstOfMonthInTimezone` helper mirrors the SQL `DATE_TRUNC('month',
    // ts AT TIME ZONE 'Asia/Almaty')` boundary used by `monthly-billing`.
    const startMonth = firstOfMonthInTimezone(today);
    const endMonth = endOfMonth(addMonthsUtc(startMonth, monthsAhead - 1));

    const invoices = await this.invoices.findByChildId(
      kindergartenId,
      childId,
      {
        periodStart: toIsoDate(startMonth),
        periodEnd: toIsoDate(endMonth),
      },
    );
    const byMonthKey = new Map<string, Invoice>();
    for (const inv of invoices) {
      // Multiple matches per month (e.g. monthly + late_pickup_fee) — prefer
      // the canonical "monthly" or prepayment row over fee invoices.
      const key = monthKey(inv.periodStart);
      const existing = byMonthKey.get(key);
      if (
        !existing ||
        (inv.invoiceType === 'monthly' && existing.invoiceType !== 'monthly') ||
        inv.invoiceType.startsWith('prepayment_')
      ) {
        byMonthKey.set(key, inv);
      }
    }

    // Resolve the active assignment + tariff plan once for projections.
    const assignment = await this.tariffAssignments.findActiveForChild(
      kindergartenId,
      childId,
      today,
    );
    const tariffPlan = assignment
      ? await this.tariffPlans.findById(kindergartenId, assignment.tariffPlanId)
      : null;
    const projectedAmountMk =
      assignment && tariffPlan ? assignment.effectiveAmount(tariffPlan) : null;
    const projectedAmount =
      projectedAmountMk === null ? null : projectedAmountMk.toNumber();

    const result: PaymentCalendarMonthEntry[] = [];
    for (let i = 0; i < monthsAhead; i++) {
      const mStart = addMonthsUtc(startMonth, i);
      const mEnd = endOfMonth(mStart);
      const holidaysAffected = await this.holidays.countNonBillableInRange(
        kindergartenId,
        mStart,
        mEnd,
      );
      const matching = byMonthKey.get(monthKey(mStart));
      if (matching) {
        result.push({
          period_start: toIsoDate(mStart),
          period_end: toIsoDate(mEnd),
          invoice_id: matching.id,
          projected_status: matching.status,
          amount_after_discount: matching.amountAfterDiscount.toNumber(),
          due_date: toIsoDate(matching.dueDate),
          is_projection: false,
          holidays_affected: holidaysAffected,
        });
      } else {
        result.push({
          period_start: toIsoDate(mStart),
          period_end: toIsoDate(mEnd),
          invoice_id: null,
          projected_status: 'projected',
          amount_after_discount: projectedAmount,
          due_date: null,
          is_projection: true,
          holidays_affected: holidaysAffected,
        });
      }
    }
    return result;
  }

  /**
   * Build a prepayment invoice covering the next `months` (3|6|12|24)
   * starting at the first day of next month after `now`. Resolves the
   * child's active tariff_assignment + plan, evaluates the matching
   * `prepay_{N}m_pct` discount rule, and persists a single invoice with
   * `invoice_type='prepayment_{N}m'`.
   *
   * Caller (`ParentPaymentController`) chains this into
   * `paymentService.initiate` to actually start the provider flow.
   */
  async prepayInvoice(
    kindergartenId: string,
    childId: string,
    months: 3 | 6 | 12 | 24,
  ): Promise<Invoice> {
    const now = this.clock.now();
    const assignment = await this.tariffAssignments.findActiveForChild(
      kindergartenId,
      childId,
      now,
    );
    if (!assignment) {
      throw new TariffAssignmentNotFoundError(childId);
    }
    const tariffPlan = await this.tariffPlans.findById(
      kindergartenId,
      assignment.tariffPlanId,
    );
    if (!tariffPlan) {
      throw new TariffPlanNotFoundError(assignment.tariffPlanId);
    }

    // Verify the requested horizon has an explicit pct configured. The
    // monthly cron does not gate on this — it is checked here so the parent
    // gets a clear 400 instead of a silent 0% prepayment.
    const ruleKey =
      `prepay_${months}m_pct` as keyof typeof tariffPlan.discountRules;
    const rulePct = tariffPlan.discountRules[ruleKey];
    if (rulePct === undefined || rulePct === null) {
      throw new BadRequestException('prepayment_horizon_not_configured');
    }

    // Period: first day of the next month → last day of (next + months-1).
    // SP2: anchor on Asia/Almaty so `clock.now()` near local midnight does
    // not shift the prepayment horizon a month back.
    const periodStart = addMonthsUtc(firstOfMonthInTimezone(now), 1);
    const periodEnd = endOfMonth(addMonthsUtc(periodStart, months - 1));

    const monthlyAmount = assignment.effectiveAmount(tariffPlan);
    const baseAmount = monthlyAmount.mul(months);

    const customCtx = await this.buildCustomDiscountInputs(
      kindergartenId,
      childId,
      periodStart,
      `prepayment_${months}m` as InvoiceType,
      now,
    );

    const discount = await this.discountEngine.evaluate({
      invoice: {
        invoiceId: 'pending',
        invoiceType: `prepayment_${months}m` as InvoiceType,
        childId,
        kindergartenId,
        amountDue: baseAmount,
        periodStart,
        periodEnd,
      },
      tariffPlan: {
        id: tariffPlan.id,
        discountRules: tariffPlan.discountRules,
      },
      context: {
        prepaymentMonths: months,
        customDiscounts: customCtx.customDiscounts,
        childContext: customCtx.childContext ?? undefined,
        familyContext: customCtx.familyContext ?? undefined,
      },
    });

    // B22a T13 H1 — release reservations for any pre-engine-reserved
    // discount that the engine ultimately did NOT include in
    // `customApplicationsToWrite` (e.g. dropped by a non-stackable gate or
    // by `evaluateConditions` returning false). Without this compensation
    // the slot stays consumed forever, prematurely exhausting capped
    // discounts. Runs in the same ambient TX so the release is durable.
    await this.releaseUnusedReservations(
      kindergartenId,
      customCtx.reservedDiscountIds,
      discount,
    );

    const amountAfter = Invoice.computeAmountAfterDiscount(
      baseAmount,
      discount.discountPct,
      discount.customDiscountAmount === null
        ? null
        : MoneyKzt.fromKzt(discount.customDiscountAmount),
    );

    const account = await this.paymentAccounts.ensureForChild(
      kindergartenId,
      childId,
    );

    const dueDate = addDaysUtc(now, 7);
    const invoiceId = randomUUID();
    const invoice = Invoice.fromState({
      id: invoiceId,
      kindergartenId,
      childId,
      paymentAccountId: account.id,
      tariffPlanId: tariffPlan.id,
      invoiceType: `prepayment_${months}m` as InvoiceType,
      periodStart,
      periodEnd,
      amountDue: baseAmount,
      discountPct: discount.discountPct,
      discountReason: discount.discountReason,
      amountAfterDiscount: amountAfter,
      status: 'pending',
      dueDate,
      description: `Prepayment ${months}m — ${toIsoDate(periodStart)}..${toIsoDate(periodEnd)}`,
      proratedForDays: null,
      createdAt: now,
      updatedAt: now,
    });
    const lineItem = InvoiceLineItem.fromState({
      id: randomUUID(),
      invoiceId,
      kindergartenId,
      description: `Prepayment ${months} months — ${tariffPlan.name}`,
      tariffPlanId: tariffPlan.id,
      quantity: months,
      unitPrice: monthlyAmount,
      lineTotal: InvoiceLineItem.compute(months, monthlyAmount),
      createdAt: now,
    });

    const persisted = await this.invoices.create(invoice, [lineItem]);
    await this.persistCustomDiscountApplications(
      kindergartenId,
      persisted,
      lineItem,
      discount,
    );
    await this.emitInvoiceCreated(persisted);
    return persisted;
  }

  // ── private helpers ────────────────────────────────────────────────────

  /**
   * Shared invoice builder used by `generateMonthly` (full month) and
   * `generateFirstInvoice` (partial month). Applies the discount engine,
   * computes pro-rata for non-billable holidays + first-month partial,
   * persists invoice + single line item.
   */
  private async generateAndPersistInvoice(args: {
    kindergartenId: string;
    assignment: TariffAssignment;
    tariffPlan: TariffPlan;
    invoiceType: InvoiceType;
    periodStart: Date;
    periodEnd: Date;
    dueDate: Date;
    totalDays: number;
    nonBillableHolidays: number;
    prepaymentMonths?: number;
    proratedBillableDays?: number;
  }): Promise<Invoice> {
    const {
      kindergartenId,
      assignment,
      tariffPlan,
      invoiceType,
      periodStart,
      periodEnd,
      dueDate,
      totalDays,
      nonBillableHolidays,
      prepaymentMonths,
      proratedBillableDays,
    } = args;
    const now = this.clock.now();
    const baseAmount = assignment.effectiveAmount(tariffPlan);
    const account = await this.paymentAccounts.ensureForChild(
      kindergartenId,
      assignment.childId,
    );

    const customCtx = await this.buildCustomDiscountInputs(
      kindergartenId,
      assignment.childId,
      periodStart,
      invoiceType,
      now,
    );

    const discount = await this.discountEngine.evaluate({
      invoice: {
        invoiceId: 'pending',
        invoiceType,
        childId: assignment.childId,
        kindergartenId,
        amountDue: baseAmount,
        periodStart,
        periodEnd,
        dueDate,
      },
      tariffPlan: {
        id: tariffPlan.id,
        discountRules: tariffPlan.discountRules,
      },
      context: {
        prepaymentMonths,
        customDiscounts: customCtx.customDiscounts,
        childContext: customCtx.childContext ?? undefined,
        familyContext: customCtx.familyContext ?? undefined,
      },
    });

    // B22a T13 H1 — see prepayInvoice for rationale.
    await this.releaseUnusedReservations(
      kindergartenId,
      customCtx.reservedDiscountIds,
      discount,
    );

    let amountAfter = Invoice.computeAmountAfterDiscount(
      baseAmount,
      discount.discountPct,
      discount.customDiscountAmount === null
        ? null
        : MoneyKzt.fromKzt(discount.customDiscountAmount),
    );

    let proratedForDays: number | null = null;
    const billableDays = proratedBillableDays ?? totalDays;
    const effectiveBillableDays = Math.max(
      0,
      billableDays - nonBillableHolidays,
    );
    if (effectiveBillableDays !== totalDays && totalDays > 0) {
      // Single-rounding chain (B22b T2): `mul(days).div(totalDays)` — each
      // op rounds once at the boundary, vs the legacy double-round
      // `roundKzt(amountAfter * days / totalDays)` which could drift by
      // up to ±0.5 tiyn per ₸ on non-divisible totals.
      amountAfter = amountAfter.mul(effectiveBillableDays).div(totalDays);
      proratedForDays = effectiveBillableDays;
    }

    const invoiceId = randomUUID();
    const invoice = Invoice.fromState({
      id: invoiceId,
      kindergartenId,
      childId: assignment.childId,
      paymentAccountId: account.id,
      tariffPlanId: tariffPlan.id,
      invoiceType,
      periodStart,
      periodEnd,
      amountDue: baseAmount,
      discountPct: discount.discountPct,
      discountReason: discount.discountReason,
      amountAfterDiscount: amountAfter,
      status: 'pending' as InvoiceStatus,
      dueDate,
      description: null,
      proratedForDays,
      createdAt: now,
      updatedAt: now,
    });

    const lineState: InvoiceLineItemState = {
      id: randomUUID(),
      invoiceId,
      kindergartenId,
      description: tariffPlan.name,
      tariffPlanId: tariffPlan.id,
      quantity: 1,
      unitPrice: baseAmount,
      lineTotal: InvoiceLineItem.compute(1, baseAmount),
      createdAt: now,
    };
    const lineItem = InvoiceLineItem.fromState(lineState);

    // B22a T3 (FINDINGS B21-T6-M3): archive-vs-invoice race protection.
    // The top-of-loop status read in `generateMonthly` happens BEFORE
    // discount evaluation + child entity hydrate; a parent / staff
    // archive call landing between that read and this INSERT would
    // silently invoice an archived child. We re-check ONLY for the
    // monthly cron path (where the loop is long-running enough to make
    // the race observable in production) and acquire a `FOR UPDATE`
    // row-level lock so a concurrent archive UPDATE blocks until our
    // INSERT TX commits or rolls back. `generateFirstInvoice`
    // (`invoiceType='monthly'` for the first month) intentionally also
    // benefits — its call site is enrollment-driven and the
    // window is microseconds rather than minutes, so the cost (one
    // extra round-trip) is negligible.
    if (invoiceType === 'monthly' && this.children) {
      const stillActive = await this.children.existsActiveByIdForUpdate(
        kindergartenId,
        assignment.childId,
      );
      if (!stillActive) {
        this.logger.warn(
          `monthly: child_archived_during_run kg=${kindergartenId} child=${assignment.childId} — skipping INSERT (archive raced with invoice)`,
        );
        // Throw a tagged error the cron loop catches; service-layer
        // sentinel keeps the contract clean (the caller does not care
        // about ChildRepository details).
        throw new ChildArchivedDuringRunError(assignment.childId);
      }
    }

    const persisted = await this.invoices.create(invoice, [lineItem]);
    await this.persistCustomDiscountApplications(
      kindergartenId,
      persisted,
      lineItem,
      discount,
    );
    await this.emitInvoiceCreated(persisted);
    return persisted;
  }

  /**
   * Outbox event for invoice creation. Producer-side only — fan-out and
   * nanny-policy filtering happen in `NotificationDispatcher` at outbox-poll
   * time. Atomic with the invoice INSERT via the ambient TX.
   *
   * NOTE on `invoice.overdue`: there is no caller for `notifyInvoiceOverdue`
   * yet. Marking an invoice overdue happens lazily today (no nightly cron);
   * the dispatcher template + recipient resolver still ship in T5c so a
   * future overdue marker (B22 polish) only needs to add the call-site.
   * Marker: `// TODO(B22): nightly overdue marking cron`.
   */
  private async emitInvoiceCreated(invoice: Invoice): Promise<void> {
    await this.notificationPort.notifyInvoiceCreated({
      kindergartenId: invoice.kindergartenId,
      invoiceId: invoice.id,
      childId: invoice.childId,
      invoiceType: invoice.invoiceType,
      amountAfterDiscount: invoice.amountAfterDiscount.toNumber(),
      dueDate: invoice.dueDate.toISOString().slice(0, 10),
      periodStart: invoice.periodStart,
      periodEnd: invoice.periodEnd,
    });
  }

  // ── B16 — custom-discount inputs + post-write applications ────────────

  /**
   * Loads + filters the kg's currently-active custom discounts down to
   * the subset eligible for THIS (child, period) tuple. Also builds the
   * `childContext` + `familyContext` shapes the engine needs for the
   * conditions evaluator.
   *
   * Filtering chain:
   *   1. `findActiveCustomDiscounts` — kg-wide, status='active', within validity window.
   *   2. `discountTargetResolver.filterDiscountsForChild` — drops discounts not
   *      targeted at this child (per targetType + conditions AST).
   *   3. `total_max_uses` guard — drops discounts at zero remaining
   *      capacity (used_count >= total_max_uses).
   *   4. `max_uses_per_child` guard — drops discounts the child already
   *      reached the per-child cap on.
   *
   * Returns empty `customDiscounts: []` when any required dep is
   * missing (B13-only callers / older spec wiring).
   */
  private async buildCustomDiscountInputs(
    kindergartenId: string,
    childId: string,
    periodStart: Date,
    _invoiceType: InvoiceType,
    now: Date,
  ): Promise<{
    customDiscounts: CustomDiscountSnapshot[];
    childContext: DiscountEvaluationInput['context']['childContext'] | null;
    familyContext: DiscountEvaluationInput['context']['familyContext'] | null;
    /**
     * IDs of discounts that consumed a `total_max_uses` slot via
     * `tryReserveUsage` BEFORE engine evaluation. Returned so the caller
     * can compensate (T13 H1) any IDs that the engine ultimately drops
     * — see `releaseUnusedReservations`.
     */
    reservedDiscountIds: string[];
  }> {
    if (
      !this.customDiscounts ||
      !this.customDiscountApplications ||
      !this.discountTargetResolver ||
      !this.children ||
      !this.childGuardians
    ) {
      return {
        customDiscounts: [],
        childContext: null,
        familyContext: null,
        reservedDiscountIds: [],
      };
    }

    // Step 1 — kg-wide active set.
    const active = await this.customDiscounts.findActiveCustomDiscounts(
      kindergartenId,
      now,
    );
    const allSnapshots = active.map((d) => toSnapshot(d));

    // Step 2 — targeting filter.
    const targeted = await this.discountTargetResolver.filterDiscountsForChild(
      kindergartenId,
      childId,
      allSnapshots,
    );

    // Step 3+4 — capacity guards (total_max_uses + per-child cap).
    //
    // T8 H1: serialise concurrent invoice flows for the same (child, discount)
    // pair via `pg_advisory_xact_lock(hashtext('discount:apply:'||kg||':'||
    // childId||':'||discountId))` BEFORE the per-child COUNT. Without this,
    // two flows could both pass the COUNT, both be deemed eligible, and
    // both write `custom_discount_applications` rows — exceeding
    // `max_uses_per_child`. The lock is held for the duration of the
    // ambient TX (HTTP-edge interceptor / cron `dataSource.transaction`)
    // and released at COMMIT/ROLLBACK. Acquired ONLY for discounts with a
    // per-child cap (cap=null = no contention to serialise).
    //
    // B22a T1 H16: total_max_uses guard is now an ATOMIC RESERVE — we
    // call `tryReserveUsage` BEFORE the engine sees the discount. If the
    // cap raced (another concurrent flow took the last slot), the
    // discount is dropped here and never reaches the engine. The
    // reservation lives inside the ambient TX — if the invoice INSERT
    // later throws, TX rollback naturally releases it (PG atomicity).
    // This eliminates the line-item/ledger drift (B16 T6-H2) that used
    // to be caused by post-INSERT `incrementUsedCount` failures.
    const eligible: CustomDiscountSnapshot[] = [];
    const reservedDiscountIds: string[] = [];
    for (const snap of targeted) {
      if (snap.maxUsesPerChild !== null) {
        await this.customDiscounts.acquireDiscountApplyAdvisoryLock(
          kindergartenId,
          snap.id,
          childId,
        );
        const used =
          await this.customDiscountApplications.countByChildAndDiscount(
            kindergartenId,
            childId,
            snap.id,
          );
        if (used >= snap.maxUsesPerChild) continue;
      }
      // total_max_uses atomic reserve. `tryReserveUsage` returns true
      // immediately for cap-disabled discounts (total_max_uses IS NULL).
      if (snap.totalMaxUses !== null) {
        const reserved = await this.customDiscounts.tryReserveUsage(
          kindergartenId,
          snap.id,
        );
        if (!reserved) {
          this.logger.log(
            `discount.cap_raced: kg=${kindergartenId} discount=${snap.id} child=${childId} — skipped before engine.`,
          );
          continue;
        }
        reservedDiscountIds.push(snap.id);
      }
      eligible.push(snap);
    }

    // Build child + family context.
    const child = await this.children.findById(kindergartenId, childId);
    const childContext = child
      ? {
          birthDate: child.dateOfBirth,
          ageInMonths: monthsBetween(child.dateOfBirth, now),
          currentGroupId: child.currentGroupId ?? null,
          // benefit_category isn't on the Child entity yet (B22+ extension);
          // keep null until that lands so the evaluator returns false for
          // the matching condition rather than throwing.
          benefitCategory: null,
        }
      : null;

    let isFirstInvoiceForChild = true;
    let siblingsInKgCount = 0;
    if (child) {
      // No-cost approximation for `firstInvoice`: list any prior invoices
      // for the child (any type) — empty list = first invoice. The
      // existing `findByChildId` query is indexed on (kg, child_id).
      //
      // B22a T1 H15: `cancelled` invoices MUST NOT count as a prior. The
      // discount engine uses `isFirstInvoiceForChild` to gate "first
      // month" promotional rules; a child whose previous month was
      // cancelled (e.g. admin reversed an enrollment) is still semantically
      // a "first invoice" for the next billable month. Without this
      // filter the engine silently dropped the first-invoice perk for any
      // child that had a cancelled invoice in the same kg.
      const priors = await this.invoices.findByChildId(kindergartenId, childId);
      isFirstInvoiceForChild = priors.every((p) => p.status === 'cancelled');
      siblingsInKgCount = await this.childGuardians.countSiblingsInKgForChild(
        kindergartenId,
        childId,
      );
    }
    const familyContext = {
      siblingsInKgCount,
      isFirstInvoiceForChild,
    };

    // Suppress unused warning on _invoiceType — currently informational, the
    // engine reads `invoice.invoiceType` directly from the input shape. We
    // keep the param so callers can pass it without TS warnings, in case a
    // future invoice-type-specific filter lands here.
    void _invoiceType;
    void periodStart;

    return {
      customDiscounts: eligible,
      childContext,
      familyContext,
      reservedDiscountIds,
    };
  }

  /**
   * B22a T13 H1 — compensation for `tryReserveUsage` slots that the
   * discount engine did NOT include in `customApplicationsToWrite`.
   *
   * Why this is needed: `buildCustomDiscountInputs` reserves a
   * `total_max_uses` slot for every targeting-passing discount BEFORE
   * the engine evaluates conditions / applies stacking. The engine then
   * may drop a reserved snapshot when:
   *   1. `evaluateConditions(snap.conditions, ctx)` returns false (e.g.
   *      "child age < 24 months" excludes the discount for older kids).
   *   2. `evaluateConditions` throws (logged + skipped).
   *   3. Stacking gates the discount (top non-stackable wins outright; a
   *      mid-list non-stackable terminates the stackable prefix).
   *   4. `remaining <= 0` after higher-priority winners filled the cap.
   *   5. `amountApplied <= 0` after rounding.
   *
   * For every dropped snapshot the `used_count` increment from step 1
   * must be released, otherwise the cap leaks and a legitimate later
   * invoice loses the discount. We call `releaseUsage` (single
   * `UPDATE … SET used_count = GREATEST(used_count - 1, 0)`) inside the
   * ambient TX so a downstream INSERT failure rolls both the original
   * reserve AND the release back together.
   *
   * Logged at debug; the loud `discount.cap_raced` log fires upstream in
   * `buildCustomDiscountInputs` for the cap-race case.
   */
  private async releaseUnusedReservations(
    kindergartenId: string,
    reservedDiscountIds: string[],
    discount: DiscountEvaluationResult,
  ): Promise<void> {
    if (!this.customDiscounts || reservedDiscountIds.length === 0) return;
    const winners = new Set(
      discount.customApplicationsToWrite.map((a) => a.customDiscountId),
    );
    for (const reservedId of reservedDiscountIds) {
      if (winners.has(reservedId)) continue;
      await this.customDiscounts.releaseUsage(kindergartenId, reservedId);
      this.logger.debug(
        `discount.reserve_released: kg=${kindergartenId} discount=${reservedId} — engine dropped post-reserve.`,
      );
    }
  }

  /**
   * Inserts one `custom_discount_applications` ledger row per matched
   * custom discount. The parent's `used_count` was already incremented
   * up-front by `buildCustomDiscountInputs.tryReserveUsage` BEFORE the
   * engine evaluation — so reaching this method means a usage slot is
   * already reserved for this invoice (or the cap was disabled). The
   * audit-row INSERT runs in the same ambient TX, so if the invoice
   * INSERT had failed before this method ran, the reservation would
   * have been rolled back along with it.
   *
   * B22a T1 H16 / B16 T6-H2: this method no longer has a "skip on cap
   * race" branch — the cap race is impossible at this stage because the
   * reserve preceded the engine evaluation. line-items and audit ledger
   * always agree.
   *
   * Short-circuits when the B16 deps are missing — keeps older spec
   * wiring (B13 race spec) green.
   */
  private async persistCustomDiscountApplications(
    kindergartenId: string,
    invoice: Invoice,
    lineItem: InvoiceLineItem,
    result: DiscountEvaluationResult,
  ): Promise<void> {
    if (
      !this.customDiscounts ||
      !this.customDiscountApplications ||
      result.customApplicationsToWrite.length === 0
    ) {
      return;
    }
    for (const app of result.customApplicationsToWrite) {
      await this.customDiscountApplications.create({
        kindergartenId,
        customDiscountId: app.customDiscountId,
        invoiceId: invoice.id,
        invoiceLineItemId: lineItem.id,
        childId: invoice.childId,
        amountApplied: app.amountApplied,
      });
    }
  }
}

/**
 * Domain → engine snapshot. Mappers are short-lived per call so the
 * transform happens inline. Mirrors the shape the engine + resolver
 * consume.
 */
function toSnapshot(d: CustomDiscount): CustomDiscountSnapshot {
  return {
    id: d.id,
    name: d.name,
    discountType: d.discountType,
    amount: d.amount,
    conditions: d.conditions,
    targetType: d.targetType,
    targetIds: d.targetIds,
    priority: d.priority,
    stackable: d.stackable,
    maxUsesPerChild: d.maxUsesPerChild,
    totalMaxUses: d.totalMaxUses,
    usedCount: d.usedCount,
    createdAt: d.createdAt,
  };
}

/**
 * Approximate months-between calculator for the conditions evaluator. Uses
 * UTC year/month diff + day-of-month adjustment so a birthday on the 30th
 * with `now` on the 29th of the same month rolls back one month
 * (matches PG `age()` semantics).
 */
function monthsBetween(from: Date, to: Date): number {
  const years = to.getUTCFullYear() - from.getUTCFullYear();
  const months = to.getUTCMonth() - from.getUTCMonth();
  let total = years * 12 + months;
  if (to.getUTCDate() < from.getUTCDate()) {
    total -= 1;
  }
  return Math.max(0, total);
}

// ── pure date helpers ────────────────────────────────────────────────────

// `startOfMonth` (UTC) deliberately removed in B22a T2: every caller now
// anchors on Asia/Almaty via `firstOfMonthInTimezone` from shared-kernel —
// see SP2 in docs/FINDINGS.md. `endOfMonth` stays UTC because once the
// canonical first-of-month (a midnight-UTC anchor) is established, the
// last-of-month derivation is unambiguous arithmetic.

function endOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
}

function daysBetweenInclusive(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  return Math.round(ms / 86_400_000) + 1;
}

function addDaysUtc(d: Date, days: number): Date {
  const out = new Date(d.getTime());
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

function addMonthsUtc(d: Date, months: number): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate()),
  );
}

function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function toIsoDate(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// Note: legacy `round2(...)`/`roundKzt(...)` helpers retired in B22b T2 —
// `MoneyKzt` from `@/shared-kernel/domain/money-kzt` is the canonical type
// for KZT arithmetic. The service performs `MoneyKzt.fromKzt(dto.amount)`
// at the DTO boundary and `.toNumber()` at the wire/notification boundary.
