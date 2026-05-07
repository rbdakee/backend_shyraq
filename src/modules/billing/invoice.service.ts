import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { NotificationPort } from '@/common/notifications/notification.port';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
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
import { InvoiceAlreadyPaidError } from './domain/errors/invoice-already-paid.error';
import { InvoiceNotFoundError } from './domain/errors/invoice-not-found.error';
import { InvoiceStatusInvalidError } from './domain/errors/invoice-status-invalid.error';
import { TariffAssignmentNotFoundError } from './domain/errors/tariff-assignment-not-found.error';
import { TariffPlanNotFoundError } from './domain/errors/tariff-plan-not-found.error';
import { DiscountEnginePort } from './infrastructure/discount-engine/discount-engine.port';
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
import { roundKzt, subtractKzt } from '@/shared-kernel/domain/money';

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
    const amountDue = input.amountDue;
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

    const lineItems: InvoiceLineItem[] = (input.lineItems ?? []).map((li) =>
      InvoiceLineItem.fromState({
        id: randomUUID(),
        invoiceId,
        kindergartenId,
        description: li.description,
        tariffPlanId: li.tariffPlanId ?? null,
        quantity: li.quantity,
        unitPrice: li.unitPrice,
        lineTotal: InvoiceLineItem.compute(li.quantity, li.unitPrice),
        createdAt: now,
      }),
    );

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
    const priorPaidSum = await this.invoices.getPaidSumForInvoice(
      kindergartenId,
      invoiceId,
    );
    const residual = roundKzt(
      subtractKzt(existingForResidual.amountAfterDiscount, priorPaidSum),
    );

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
    const paymentAmount = residual > 0 ? residual : updated.amountAfterDiscount;
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

    if (residual > 0) {
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
      amount: cashPayment.amount,
      provider: 'cash',
      paidAt,
    });
    await this.notificationPort.notifyInvoicePaid({
      kindergartenId,
      invoiceId: updated.id,
      childId: updated.childId,
      amountAfterDiscount: updated.amountAfterDiscount,
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
    for (const assignment of assignments) {
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
        continue;
      }
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
    }

    return { generated, skipped: 0 };
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
    const periodStart = startOfMonth(input.enrollmentDate);
    const periodEnd = endOfMonth(input.enrollmentDate);
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
    let amount: number;
    let tariffPlanId: string | null;
    if (tariffPlan) {
      amount = tariffPlan.amount;
      tariffPlanId = tariffPlan.id;
    } else if (input.lateFeeAmountKzt !== undefined) {
      amount = input.lateFeeAmountKzt;
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
    const startMonth = startOfMonth(today);
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
    const projectedAmount =
      assignment && tariffPlan ? assignment.effectiveAmount(tariffPlan) : null;

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
          amount_after_discount: matching.amountAfterDiscount,
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
    const periodStart = addMonthsUtc(startOfMonth(now), 1);
    const periodEnd = endOfMonth(addMonthsUtc(periodStart, months - 1));

    const monthlyAmount = assignment.effectiveAmount(tariffPlan);
    const baseAmount = roundKzt(monthlyAmount * months);

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
      context: { prepaymentMonths: months },
    });

    const amountAfter = Invoice.computeAmountAfterDiscount(
      baseAmount,
      discount.discountPct,
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

    const discount = await this.discountEngine.evaluate({
      invoice: {
        invoiceId: 'pending',
        invoiceType,
        childId: assignment.childId,
        kindergartenId,
        amountDue: baseAmount,
        periodStart,
        periodEnd,
      },
      tariffPlan: {
        id: tariffPlan.id,
        discountRules: tariffPlan.discountRules,
      },
      // TODO(B13 review): wire siblingsCount from ChildGuardianRepository
      // (a sibling-count cross-module integration). Mock engine ignores
      // when the field is undefined, so omitting is safe for B13.
      context: {
        prepaymentMonths,
      },
    });

    let amountAfter = Invoice.computeAmountAfterDiscount(
      baseAmount,
      discount.discountPct,
    );

    let proratedForDays: number | null = null;
    const billableDays = proratedBillableDays ?? totalDays;
    const effectiveBillableDays = Math.max(
      0,
      billableDays - nonBillableHolidays,
    );
    if (effectiveBillableDays !== totalDays && totalDays > 0) {
      amountAfter = roundKzt((amountAfter * effectiveBillableDays) / totalDays);
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

    const persisted = await this.invoices.create(invoice, [lineItem]);
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
      amountAfterDiscount: invoice.amountAfterDiscount,
      dueDate: invoice.dueDate.toISOString().slice(0, 10),
      periodStart: invoice.periodStart,
      periodEnd: invoice.periodEnd,
    });
  }
}

// ── pure date helpers ────────────────────────────────────────────────────

function startOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

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

// Note: legacy `round2(...)` was removed in T11 H7 — `roundKzt(...)` from
// `@/shared-kernel/domain/money` is the canonical helper now.
