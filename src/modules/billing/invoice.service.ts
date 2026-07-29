import {
  BadRequestException,
  ForbiddenException,
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
import { PrepaymentBlockedOutstandingDebtError } from './domain/errors/prepayment-blocked-outstanding-debt.error';
import { PrepaymentBlockedPartialPrepaymentError } from './domain/errors/prepayment-blocked-partial-prepayment.error';
import { PrepaymentBlockedWindowOverlapError } from './domain/errors/prepayment-blocked-window-overlap.error';
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
import { Decimal } from 'decimal.js';

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
  /**
   * Cash amount received. Omitted (or exactly equal to the remaining
   * balance) → full settlement, invoice → `paid`. 0 < amount < remaining →
   * partial cash receipt, invoice → `partial`. Mirrors the
   * `payment_mode=partial` contract of `PaymentService.initiate`.
   */
  amount?: number | null;
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
  /** `invoice_type` of the backing invoice — null on projected rows. */
  invoice_type: string | null;
}

/** Per-month row of a `PrepaymentQuote` (handoff §2.4 / §2.6). */
export interface PrepaymentQuoteMonth {
  periodStart: Date;
  periodEnd: Date;
  /** Holiday-adjusted pre-discount month price — full precision. */
  baseAmount: MoneyKzt;
  holidayDays: number;
  /** Whole-tenge slice of the discounted `total` (Σ shares === total exactly). */
  amountShare: MoneyKzt;
}

/**
 * Blocked quote — nothing computed, no side effects occurred. Three
 * reasons (review fixes 2/9 extended the original §2.2 debt block):
 *   - `outstanding_debt` (§2.2) — unpaid non-prepayment invoices;
 *   - `partial_prepayment_exists` (FIX 2) — a stale prepayment holds
 *     parent money and must not be auto-cancelled;
 *   - `window_overlaps_covered` (FIX 9) — non-contiguous paid coverage
 *     inside the shifted window would silently double-bill a month.
 */
export interface PrepaymentQuoteBlocked {
  blockedReason:
    | 'outstanding_debt'
    | 'partial_prepayment_exists'
    | 'window_overlaps_covered';
  /**
   * KZT — Σ(amount_after_discount − completed paid) over the blocking
   * invoices. Present only for `outstanding_debt`.
   */
  outstandingAmount?: number;
  /** The money-holding stale prepayment. `partial_prepayment_exists` only. */
  blockedInvoiceId?: string;
  /** Completed-paid KZT inside it. `partial_prepayment_exists` only. */
  blockedPaidAmount?: number;
  /** Covered `YYYY-MM` keys inside the window. `window_overlaps_covered` only. */
  coveredMonths?: string[];
}

export interface PrepaymentQuoteComputed {
  blockedReason?: undefined;
  windowStart: Date;
  windowEnd: Date;
  months: PrepaymentQuoteMonth[];
  discountPct: number | null;
  /** Full engine result — P2 persists `customApplicationsToWrite` from it. */
  discountResult: DiscountEvaluationResult;
  /**
   * Capped discounts whose `total_max_uses` slot was reserved (reserve mode
   * only; `[]` in preview mode). Non-winner reservations are ALREADY
   * released inside the quote — callers must not release them again.
   */
  reservedDiscountIds: string[];
  /** Σ month bases, pre-discount, full precision → `invoice.amountDue`. */
  baseTotal: MoneyKzt;
  /** Discounted + whole-tenge quantized → `invoice.amountAfterDiscount`. */
  total: MoneyKzt;
  /** Resolved here so the create path (P2) avoids a re-fetch. */
  tariffPlan: TariffPlan;
  assignment: TariffAssignment;
}

export type PrepaymentQuote = PrepaymentQuoteBlocked | PrepaymentQuoteComputed;

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

  /**
   * Completed-payment total for a single invoice — feeds the presenter's
   * `amount_paid` / `amount_remaining` on single-invoice read endpoints, and
   * lets the parent pay route derive the outstanding balance.
   */
  async getPaidSum(kindergartenId: string, invoiceId: string): Promise<number> {
    return this.invoices.getPaidSumForInvoice(kindergartenId, invoiceId);
  }

  /**
   * Batch variant for list endpoints — one query for the whole page instead
   * of N × `getPaidSum`. Returns `Map<invoiceId, paidSum>` (missing → 0).
   */
  async getPaidSums(
    kindergartenId: string,
    invoiceIds: string[],
  ): Promise<Map<string, number>> {
    return this.invoices.getPaidSumsForInvoices(kindergartenId, invoiceIds);
  }

  /**
   * Parent-side guardian re-check for invoice/calendar read endpoints.
   *
   * Used by `ParentInvoiceController` for every route — `ChildAccessGuard`
   * already handles `:childId` paths (cross-tenant + approved-active), but
   * `:id` invoice routes need an explicit re-check anyway, AND the
   * guardian role itself isn't surfaced by the guard. We need the role
   * here to gate nanny per BP §4.13 (nanny → 403 on every billing read).
   *
   * Throws `ForbiddenException('not_a_guardian')` when the caller has no
   * approved-active link to the child (catches the `:id` route where the
   * caller may be a guardian of a different child in the same kg) and
   * `ForbiddenException('nanny_cannot_view_invoice')` when the link is a
   * nanny.
   */
  async assertNonNannyGuardianForRead(
    kindergartenId: string,
    userId: string,
    childId: string,
  ): Promise<void> {
    if (!this.childGuardians) {
      // Wiring sanity check — older test specs that build InvoiceService
      // without ChildGuardianRepository can call business methods just
      // fine, but the parent-side read assert is wired only when the
      // module pulls in ChildModule. If we somehow get here without the
      // dep, fail closed (treat as "not a guardian") rather than leaking
      // data through a missing check.
      throw new ForbiddenException('not_a_guardian');
    }
    const guardian = await this.childGuardians.findApprovedActiveByUserAndChild(
      kindergartenId,
      childId,
      userId,
    );
    if (!guardian) {
      throw new ForbiddenException('not_a_guardian');
    }
    if (guardian.role.value === 'nanny') {
      throw new ForbiddenException('nanny_cannot_view_invoice');
    }
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
   * `input.amount` mirrors the gateway `payment_mode=partial` contract of
   * `PaymentService.initiate`: omitted or equal to the remaining balance →
   * full settlement (invoice → `paid`); 0 < amount < remaining → partial
   * cash receipt (invoice → `partial`, no `invoice.paid` event); amount ≤ 0
   * or > remaining → `InvoiceStatusInvalidError('amount_mismatch_partial')`.
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
    if (existingForResidual.invoiceType.startsWith('prepayment_')) {
      // Review FIX 6 — serialise a cash settlement of a prepayment against
      // a concurrent `prepayInvoice` for the same child (which takes the
      // same lock first thing). Held until the ambient TX commits.
      await this.invoices.acquireChildPrepaymentAdvisoryLock(
        kindergartenId,
        existingForResidual.childId,
      );
    }
    const priorPaidSum = MoneyKzt.fromKzt(
      await this.invoices.getPaidSumForInvoice(kindergartenId, invoiceId),
    );
    const residual = existingForResidual.amountAfterDiscount.sub(priorPaidSum);

    if (input.amount !== undefined && input.amount !== null) {
      // Status pre-check mirrors `PaymentService.initiate` — validate before
      // touching amounts so a paid invoice yields `invoice_already_paid`,
      // not `amount_mismatch_partial`. Races still land on the conditional
      // UPDATE below.
      if (existingForResidual.status === 'paid') {
        throw new InvoiceAlreadyPaidError(invoiceId);
      }
      if (
        existingForResidual.status !== 'pending' &&
        existingForResidual.status !== 'partial' &&
        existingForResidual.status !== 'overdue'
      ) {
        throw new InvoiceStatusInvalidError(
          existingForResidual.status,
          'manualMarkPaid',
        );
      }
      const inputAmount = MoneyKzt.fromKzt(input.amount);
      if (!inputAmount.isPositive() || inputAmount.gt(residual)) {
        throw new InvoiceStatusInvalidError(
          existingForResidual.status,
          'amount_mismatch_partial',
        );
      }
      if (!inputAmount.equals(residual)) {
        return this.recordPartialCashPayment(
          kindergartenId,
          existingForResidual,
          inputAmount,
          input,
          now,
        );
      }
      // amount === remaining → full settlement, same as an omitted amount.
    }

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

    // §2.8 / review FIX 4 — a cash-settled prepayment supersedes the unpaid
    // monthlies its window covers, exactly like the gateway settlement hook
    // in `PaymentService.applyCompletedPayment`. Fires only on a FULL flip
    // (the partial branch returned earlier) that THIS call performed.
    if (updated.invoiceType.startsWith('prepayment_')) {
      await this.cancelCoveredMonthliesForPrepayment(
        kindergartenId,
        updated,
        now,
      );
    }

    // T11 C3: synthesise a Payment row with provider='cash'. Without this
    // GET /admin/payments would never show cash receipts, getPaidSumForInvoice
    // would return 0 forever for cash-paid invoices, and the refund flow on
    // those invoices would fail (no payment row to flip → refunded). The
    // Payment row's amount is the residual at the moment of the cash
    // receipt (a sub-residual cash amount goes through
    // `recordPartialCashPayment` above and never reaches this path) —
    // using the residual rather than amount_after_discount keeps the
    // ledger correct if a partial gateway payment landed earlier.
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

  /**
   * Partial cash receipt — mirrors the gateway partial settlement in
   * `PaymentService` (payment.completed handler): flip `pending`/`overdue`
   * → `partial` (an invoice already `partial` stays as-is), record a
   * completed `provider='cash'` Payment for the partial amount, credit the
   * payment_account, and emit `payment.completed` WITHOUT `invoice.paid` —
   * the invoice is not settled.
   */
  private async recordPartialCashPayment(
    kindergartenId: string,
    invoice: Invoice,
    amount: MoneyKzt,
    input: ManualMarkPaidInput,
    now: Date,
  ): Promise<Invoice> {
    let updated: Invoice = invoice;
    if (invoice.status !== 'partial') {
      const flipped = await this.invoices.markPartialConditional(
        kindergartenId,
        invoice.id,
        now,
      );
      if (flipped) {
        updated = flipped;
      } else {
        // Race lost between the pre-check read and the conditional UPDATE —
        // re-read and disambiguate like the full path does.
        const reread = await this.invoices.findById(kindergartenId, invoice.id);
        if (!reread) {
          throw new InvoiceNotFoundError(invoice.id);
        }
        if (reread.status === 'partial') {
          // A concurrent partial payment flipped it first — already the
          // state we want; proceed with the cash receipt.
          updated = reread;
        } else if (reread.status === 'paid') {
          throw new InvoiceAlreadyPaidError(invoice.id);
        } else {
          throw new InvoiceStatusInvalidError(reread.status, 'manualMarkPaid');
        }
      }
    }

    const paidAt = input.paidAt ?? now;
    const cashPayment = Payment.fromState({
      id: randomUUID(),
      kindergartenId,
      invoiceId: updated.id,
      childId: updated.childId,
      payerUserId: input.payerUserId ?? null,
      amount,
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

    await this.paymentAccounts.creditFromPayment(
      kindergartenId,
      updated.paymentAccountId,
      amount,
    );
    await this.notificationPort.notifyPaymentCompleted({
      kindergartenId,
      paymentId: cashPayment.id,
      childId: updated.childId,
      invoiceId: updated.id,
      amount: cashPayment.amount.toNumber(),
      provider: 'cash',
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
    // Review FIX 8 — keep `used_count` symmetric with the status-aware
    // per-child cap (`countByChildAndDiscount` excludes voided invoices):
    // an admin-cancelled invoice must not keep consuming capped
    // custom-discount slots, same as the prepayment-retry / settlement-hook
    // cancels.
    await this.releaseCustomDiscountUsagesForInvoice(
      kindergartenId,
      updated.id,
    );
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
   * and one-offs do not block re-runs). Children whose period is covered
   * by a PAID prepayment window are skipped per-child (handoff §2.7 / P4).
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
    // Prepayment coverage (handoff §2.7 / P4): children whose PAID
    // prepayment_* window contains this period are skipped below. ONE
    // kg-wide query here, Set lookup per child — never a per-child query.
    const coveredByPrepayment = new Set(
      await this.invoices.listChildIdsWithPaidPrepaymentCovering(
        kindergartenId,
        periodStart,
      ),
    );

    let generated = 0;
    let skipped = 0;
    for (const assignment of assignments) {
      // Cheapest guard first: paid-prepayment coverage skip (handoff §5.1).
      // The branch has zero side effects, so a repeat cron run (e.g. when
      // ALL children are covered and the existsMonthlyForPeriod
      // short-circuit never arms) re-skips harmlessly.
      if (coveredByPrepayment.has(assignment.childId)) {
        this.logger.log(
          `monthly: skipping child=${assignment.childId} — covered by paid prepayment`,
        );
        skipped++;
        continue;
      }
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
   * Months covered by a PAID prepayment (§2.9 / P6) render as `paid` rows
   * of that prepayment invoice with the month's line-item share as the
   * amount. Pending/partial prepayments are NOT spread — they stay visible
   * only in their `period_start` month, like today.
   *
   * `monthsAhead` outside `[1, 24]` → 400. The starting month is the first
   * day of the current Almaty month (DB stores `period_start` as `date`).
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

    // Paid-prepayment coverage spread (§2.9 / P6). Separate fetch on
    // `period_end >= startMonth`: a paid prepayment whose window started
    // before the calendar horizon (or ends past it) is invisible to the
    // bucketing fetch above (`period_start >= startMonth AND period_end <=
    // endMonth`), yet still covers months inside it.
    const paidPrepayments = await this.invoices.findPaidPrepaymentsByChild(
      kindergartenId,
      childId,
      startMonth,
    );
    const coverage = new Map<string, { invoice: Invoice; share: MoneyKzt }>();
    if (paidPrepayments.length > 0) {
      const prepayLineItems = await this.invoiceLineItems.listByInvoiceIds(
        kindergartenId,
        paidPrepayments.map((p) => p.id),
      );
      const itemsByInvoice = new Map<string, InvoiceLineItem[]>();
      for (const item of prepayLineItems) {
        const list = itemsByInvoice.get(item.invoiceId) ?? [];
        list.push(item);
        itemsByInvoice.set(item.invoiceId, list);
      }
      for (const p of paidPrepayments) {
        const windowMonths: Date[] = [];
        for (
          let m = p.periodStart;
          m.getTime() <= p.periodEnd.getTime();
          m = addMonthsUtc(m, 1)
        ) {
          windowMonths.push(m);
        }
        const items = (itemsByInvoice.get(p.id) ?? []).sort(
          (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
        );
        for (let i = 0; i < windowMonths.length; i++) {
          // P2 writes one line item per covered month (created_at ASC, i-th
          // item → i-th window month). Legacy pre-fix prepayments carry a
          // single `quantity=months` item — fall back to an even split so
          // they render instead of crashing the calendar.
          const share =
            items.length === windowMonths.length
              ? items[i].lineTotal
              : p.amountAfterDiscount.div(windowMonths.length);
          coverage.set(monthKey(windowMonths[i]), { invoice: p, share });
        }
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
      const covered = coverage.get(monthKey(mStart));
      const matching = byMonthKey.get(monthKey(mStart));
      if (covered) {
        // Coverage wins over a matching invoice (§2.9): if a monthly
        // slipped in before the settlement hook cancelled it, the month
        // still reads as paid-by-prepayment.
        result.push({
          period_start: toIsoDate(mStart),
          period_end: toIsoDate(mEnd),
          invoice_id: covered.invoice.id,
          projected_status: 'paid',
          amount_after_discount: covered.share.round().toNumber(),
          due_date: toIsoDate(covered.invoice.dueDate),
          is_projection: false,
          holidays_affected: holidaysAffected,
          invoice_type: covered.invoice.invoiceType,
        });
      } else if (matching) {
        result.push({
          period_start: toIsoDate(mStart),
          period_end: toIsoDate(mEnd),
          invoice_id: matching.id,
          projected_status: matching.status,
          amount_after_discount: matching.amountAfterDiscount.toNumber(),
          due_date: toIsoDate(matching.dueDate),
          is_projection: false,
          holidays_affected: holidaysAffected,
          invoice_type: matching.invoiceType,
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
          invoice_type: null,
        });
      }
    }
    return result;
  }

  /**
   * Prepayment quote (handoff §2 / P1) — single source of truth for both
   * invoice creation (P2, reserve mode) and the read-only preview endpoint
   * (P3, preview mode).
   *
   * Pipeline:
   *   1. Debt block (§2.2) — any `pending|overdue|partial` NON-prepayment
   *      invoice of the child blocks the quote, checked BEFORE any
   *      reservation side effects. Unpaid prepayments are not debt (P2
   *      cancels pending/overdue ones on retry).
   *   2. Window shift (§2.3) — first day of the next Almaty month, walked
   *      forward past every month already covered by a PAID prepayment.
   *   3. Per-month holiday math (§2.4) — `price × (days − holidays) / days`
   *      per covered month, full-precision MoneyKzt chain. Holidays are
   *      snapshotted at quote time; later holiday/tariff edits do not
   *      reprice (§2.4 — price is fixed at creation).
   *   4. ONE discount-engine evaluate over the summed base with
   *      `context.prepaymentMonths` (§5.7) — never per month, so
   *      `prepay_N_pct` applies once and capped custom discounts consume at
   *      most one slot.
   *   5. Whole-tenge quantization of the discounted total (§2.5, Bug 2) —
   *      the only rounding in the chain.
   *   6. Largest-remainder split of the total into whole-tenge per-month
   *      shares (§2.6) — these become the per-month line items (P2) and the
   *      calendar amounts (P6).
   *
   * Side effects: reserve mode (default) reserves capped custom-discount
   * slots via `tryReserveUsage` and already releases non-winner
   * reservations here; the caller only persists the winner applications.
   * Preview mode (`reserveCustomDiscounts: false`) writes nothing and takes
   * no advisory locks — read-only capacity guards only.
   */
  async computePrepaymentQuote(
    kindergartenId: string,
    childId: string,
    months: 3 | 6 | 12 | 24,
    opts?: { reserveCustomDiscounts?: boolean },
  ): Promise<PrepaymentQuote> {
    const reserve = opts?.reserveCustomDiscounts ?? true;
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

    // Horizon gate — kept as a Nest BadRequestException (not a DomainError)
    // for contract compat with the existing pay/prepayment route.
    const ruleKey =
      `prepay_${months}m_pct` as keyof typeof tariffPlan.discountRules;
    const rulePct = tariffPlan.discountRules[ruleKey];
    if (rulePct === undefined || rulePct === null) {
      throw new BadRequestException('prepayment_horizon_not_configured');
    }

    // 1 — debt block (§2.2), before any reservation side effects.
    const outstanding = await this.computeOutstandingDebt(
      kindergartenId,
      childId,
    );
    if (outstanding !== null) {
      return {
        blockedReason: 'outstanding_debt',
        outstandingAmount: outstanding.round().toNumber(),
      };
    }

    // 1b — money-holding stale prepayment blocks the quote (review FIX 2).
    // The create path (`prepayInvoice`) cancels zero-paid stale prepayments
    // BEFORE calling this quote, so on create this check only ever fires
    // for the money-holding case that survived the pre-check race-free
    // under the child advisory lock. The read-only preview relies on it as
    // the single detection point — nothing is cancelled here.
    const stale = await this.invoices.findUnpaidPrepaymentsByChild(
      kindergartenId,
      childId,
    );
    const holding = await this.findMoneyHoldingPrepayment(
      kindergartenId,
      stale,
    );
    if (holding) {
      return {
        blockedReason: 'partial_prepayment_exists',
        blockedInvoiceId: holding.invoice.id,
        blockedPaidAmount: holding.paidAmount,
      };
    }

    // 2 — window shift (§2.3). SP2: Almaty anchor applies only to
    // `clock.now()`; stored period dates are canonical midnight-UTC anchors
    // (mapper `toDate`), so pure UTC month arithmetic on them is correct.
    // The covered-month-key walk is robust against multiple / overlapping
    // paid prepayments — not just max(period_end).
    let windowStart = addMonthsUtc(firstOfMonthInTimezone(now), 1);
    const paidPrepayments = await this.invoices.findPaidPrepaymentsByChild(
      kindergartenId,
      childId,
      windowStart,
    );
    const coveredMonthKeys = new Set<string>();
    for (const p of paidPrepayments) {
      for (
        let m = p.periodStart;
        m.getTime() <= p.periodEnd.getTime();
        m = addMonthsUtc(m, 1)
      ) {
        coveredMonthKeys.add(monthKey(m));
      }
    }
    while (coveredMonthKeys.has(monthKey(windowStart))) {
      windowStart = addMonthsUtc(windowStart, 1);
    }
    const windowEnd = endOfMonth(addMonthsUtc(windowStart, months - 1));

    // 2b — window-overlap guard (review FIX 9). The shift walk moves the
    // START past covered months, but non-contiguous coverage (e.g. a
    // refunded middle window) can leave covered months INSIDE the shifted
    // window. Silently billing them would double-charge — block instead.
    // §2.3 "shift start only" is preserved for the contiguous normal case.
    const overlappingCovered: string[] = [];
    for (let i = 0; i < months; i++) {
      const key = monthKey(addMonthsUtc(windowStart, i));
      if (coveredMonthKeys.has(key)) {
        overlappingCovered.push(key);
      }
    }
    if (overlappingCovered.length > 0) {
      return {
        blockedReason: 'window_overlaps_covered',
        coveredMonths: overlappingCovered,
      };
    }

    // 3 — per-month base amounts (§2.4): full-precision chain, no
    // intermediate rounding (B22b T2/T15 — quantize only at sinks).
    // `dayWeights` carries the per-month billable-day fraction for the
    // share split below — the monthly price cancels out of the ratio, so
    // the day fractions alone are the exact full-precision weights.
    const monthlyAmount = assignment.effectiveAmount(tariffPlan);
    const monthEntries: PrepaymentQuoteMonth[] = [];
    const dayWeights: Decimal[] = [];
    let baseTotal = MoneyKzt.zero();
    for (let i = 0; i < months; i++) {
      const mStart = addMonthsUtc(windowStart, i);
      const mEnd = endOfMonth(mStart);
      const totalDays = daysBetweenInclusive(mStart, mEnd);
      const holidayDays = await this.holidays.countNonBillableInRange(
        kindergartenId,
        mStart,
        mEnd,
      );
      const effectiveDays = Math.max(0, totalDays - holidayDays);
      const baseAmount = monthlyAmount.mul(effectiveDays).div(totalDays);
      baseTotal = baseTotal.add(baseAmount);
      dayWeights.push(new Decimal(effectiveDays).div(totalDays));
      monthEntries.push({
        periodStart: mStart,
        periodEnd: mEnd,
        baseAmount,
        holidayDays,
        amountShare: MoneyKzt.zero(), // assigned after quantization below
      });
    }

    // 4 — ONE engine call over the summed base (§5.7): `prepay_N_pct`
    // applies once via `prepaymentMonths`; looping the engine per month
    // would re-reserve capped slots AND multiply ledger rows. `dueDate` is
    // deliberately omitted from the engine input on the prepay path
    // (computed after the quote), matching the existing prepayInvoice call.
    const invoiceType = `prepayment_${months}m` as InvoiceType;
    const customCtx = await this.buildCustomDiscountInputs(
      kindergartenId,
      childId,
      windowStart,
      invoiceType,
      now,
      reserve,
    );
    const discount = await this.discountEngine.evaluate({
      invoice: {
        invoiceId: 'pending',
        invoiceType,
        childId,
        kindergartenId,
        amountDue: baseTotal,
        periodStart: windowStart,
        periodEnd: windowEnd,
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
    // B22a T13 H1 — compensate reservations the engine dropped. No-op in
    // preview mode (reservedDiscountIds is empty).
    await this.releaseUnusedReservations(
      kindergartenId,
      customCtx.reservedDiscountIds,
      discount,
    );

    // 5 — single-rounding chain to whole tenge (§2.5): the discounted total
    // is quantized exactly once, at the sink.
    const amountAfter = Invoice.computeAmountAfterDiscount(
      baseTotal,
      discount.discountPct,
      discount.customDiscountAmount === null
        ? null
        : MoneyKzt.fromKzt(discount.customDiscountAmount),
    );
    const total = amountAfter.roundToWholeKzt();

    // 6 — whole-tenge per-month shares (§2.6).
    const shares = distributeWholeTenge(total, dayWeights);
    for (let i = 0; i < months; i++) {
      monthEntries[i].amountShare = shares[i];
    }

    return {
      windowStart,
      windowEnd,
      months: monthEntries,
      discountPct: discount.discountPct,
      discountResult: discount,
      reservedDiscountIds: customCtx.reservedDiscountIds,
      baseTotal,
      total,
      tariffPlan,
      assignment,
    };
  }

  /**
   * Build a prepayment invoice from `computePrepaymentQuote` (reserve
   * mode): debt block (§2.2), window shifted past months already covered
   * by a paid prepayment (§2.3), per-month holiday math (§2.4) and a
   * whole-tenge total (§2.5). Persists ONE invoice with a line item per
   * covered month (§2.6) — the calendar (P6) reads the exact monthly
   * shares back from those items in `created_at` order.
   *
   * Ordering (review FIX 3, all in the ambient TX so a later throw rolls
   * the cancels back):
   *   1. per-child advisory lock (FIX 6) — serialises with a concurrent
   *      settlement of the same child's prepayment;
   *   2. cheap debt pre-check — a debt-blocked retry cancels NOTHING;
   *   3. stale-prepayment handling (FIX 2) — any stale `prepayment_*` row
   *      with completed-paid money inside BLOCKS the attempt
   *      (`prepayment_blocked_partial_prepayment`); zero-paid rows are
   *      conditionally cancelled and their capped custom-discount slots
   *      released. Deliberately NO `notifyInvoiceCancelled` for the
   *      replacement cancel: parent-initiated, not an admin action;
   *   4. ONLY THEN the quote in reserve mode — so the cancelled stale
   *      invoice's ledger rows are status-excluded and its `used_count`
   *      slot is freed before the quote counts/reserves.
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
    await this.invoices.acquireChildPrepaymentAdvisoryLock(
      kindergartenId,
      childId,
    );

    // FIX 3 step 2 — debt pre-check BEFORE any cancel side effect.
    const outstanding = await this.computeOutstandingDebt(
      kindergartenId,
      childId,
    );
    if (outstanding !== null) {
      throw new PrepaymentBlockedOutstandingDebtError(
        outstanding.round().toNumber(),
      );
    }

    // FIX 3 step 3 / FIX 2 — stale prepayments: block on money, cancel the
    // rest.
    const stale = await this.invoices.findUnpaidPrepaymentsByChild(
      kindergartenId,
      childId,
    );
    const holding = await this.findMoneyHoldingPrepayment(
      kindergartenId,
      stale,
    );
    if (holding) {
      throw new PrepaymentBlockedPartialPrepaymentError(
        holding.invoice.id,
        holding.paidAmount,
      );
    }
    for (const old of stale) {
      const cancelled = await this.invoices.markCancelledConditional(
        kindergartenId,
        old.id,
        now,
      );
      // null = raced (settled / already cancelled meanwhile) — leave as-is.
      if (!cancelled) continue;
      await this.releaseCustomDiscountUsagesForInvoice(kindergartenId, old.id);
      this.logger.log(
        `prepayment.retry: cancelled stale prepayment ${old.id} kg=${kindergartenId} child=${childId}`,
      );
    }

    // FIX 3 step 4 — quote AFTER the cancels.
    const quote = await this.computePrepaymentQuote(
      kindergartenId,
      childId,
      months,
      { reserveCustomDiscounts: true },
    );
    if (quote.blockedReason) {
      switch (quote.blockedReason) {
        case 'partial_prepayment_exists':
          // Belt-and-braces — the pre-check above already threw for this.
          throw new PrepaymentBlockedPartialPrepaymentError(
            quote.blockedInvoiceId ?? '',
            quote.blockedPaidAmount ?? 0,
          );
        case 'window_overlaps_covered':
          throw new PrepaymentBlockedWindowOverlapError(
            quote.coveredMonths ?? [],
          );
        case 'outstanding_debt':
        default:
          throw new PrepaymentBlockedOutstandingDebtError(
            quote.outstandingAmount ?? 0,
          );
      }
    }

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
      tariffPlanId: quote.tariffPlan.id,
      invoiceType: `prepayment_${months}m` as InvoiceType,
      periodStart: quote.windowStart,
      periodEnd: quote.windowEnd,
      // numeric(12,2) persist precision — PG would round the
      // full-precision base sum on write anyway; rounding here keeps the
      // returned domain object identical to the round-tripped row.
      amountDue: quote.baseTotal.round(),
      discountPct: quote.discountResult.discountPct,
      discountReason: quote.discountResult.discountReason,
      amountAfterDiscount: quote.total,
      status: 'pending',
      dueDate,
      description: `Prepayment ${months}m — ${toIsoDate(quote.windowStart)}..${toIsoDate(quote.windowEnd)}`,
      proratedForDays: null,
      createdAt: now,
      updatedAt: now,
    });
    // One line item per covered month (§2.6): quantity=1, unitPrice =
    // lineTotal = the month's whole-tenge share of the discounted total.
    // `createdAt` is offset by +i ms — all-equal timestamps would make
    // `listByInvoice` (ORDER BY created_at ASC) unstable and break the
    // calendar's index→month mapping (P6).
    const lineItems = quote.months.map((m, i) =>
      InvoiceLineItem.fromState({
        id: randomUUID(),
        invoiceId,
        kindergartenId,
        description: `Prepayment ${monthKey(m.periodStart)} — ${quote.tariffPlan.name}`,
        tariffPlanId: quote.tariffPlan.id,
        quantity: 1,
        unitPrice: m.amountShare,
        lineTotal: m.amountShare,
        createdAt: new Date(now.getTime() + i),
      }),
    );

    const persisted = await this.invoices.create(invoice, lineItems);
    // ONE ledger row per winner discount, anchored to the first month's
    // line item — never one per month (§5.7). Non-winner reservations were
    // already released inside the quote.
    await this.persistCustomDiscountApplications(
      kindergartenId,
      persisted,
      lineItems[0],
      quote.discountResult,
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
   *
   * `reserve` (default true) — preview mode (`false`, prepayment-preview
   * P3) skips `tryReserveUsage` AND the per-(child,discount) advisory
   * locks: a GET must not consume `total_max_uses` slots (winners' — i.e.
   * non-released — reservations would leak on every preview) nor hold
   * locks. Read-only guards (per-child count, snapshot `used_count` vs
   * cap) still run, so the preview reflects capacity best-effort; the
   * create path re-runs in reserve mode and remains the only authority.
   */
  private async buildCustomDiscountInputs(
    kindergartenId: string,
    childId: string,
    periodStart: Date,
    _invoiceType: InvoiceType,
    now: Date,
    reserve = true,
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
        if (reserve) {
          await this.customDiscounts.acquireDiscountApplyAdvisoryLock(
            kindergartenId,
            snap.id,
            childId,
          );
        }
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
        if (!reserve) {
          // Preview mode: snapshot-read capacity guard only — no slot
          // consumed, so no compensation needed either.
          if (snap.usedCount >= snap.totalMaxUses) continue;
        } else {
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
   * §2.2 debt computation shared by `computePrepaymentQuote` (blocked-quote
   * path) and the `prepayInvoice` pre-check (review FIX 3: the debt check
   * must run BEFORE any stale-prepayment cancel so a debt-blocked retry
   * cancels nothing). Returns `null` when the child has no unsettled
   * non-prepayment invoice; otherwise the KZT remainder summed over the
   * blocking invoices (possibly zero — presence of the invoices blocks,
   * not the amount).
   */
  private async computeOutstandingDebt(
    kindergartenId: string,
    childId: string,
  ): Promise<MoneyKzt | null> {
    const unpaid = await this.invoices.findUnpaidNonPrepaymentByChild(
      kindergartenId,
      childId,
    );
    if (unpaid.length === 0) return null;
    const paidSums = await this.invoices.getPaidSumsForInvoices(
      kindergartenId,
      unpaid.map((i) => i.id),
    );
    let outstanding = MoneyKzt.zero();
    for (const inv of unpaid) {
      const paid = MoneyKzt.fromKzt(paidSums.get(inv.id) ?? 0);
      const remaining = inv.amountAfterDiscount.sub(paid);
      if (remaining.isPositive()) {
        outstanding = outstanding.add(remaining);
      }
    }
    return outstanding;
  }

  /**
   * Review FIX 2 money guard — the first stale prepayment holding a
   * completed-paid sum > 0, whatever its status (a `partial` row flipped to
   * `overdue` by `markOverdueBatch` still holds the parent's money).
   * `null` when every stale row is zero-paid (safe to cancel).
   */
  private async findMoneyHoldingPrepayment(
    kindergartenId: string,
    stale: Invoice[],
  ): Promise<{ invoice: Invoice; paidAmount: number } | null> {
    if (stale.length === 0) return null;
    const paidSums = await this.invoices.getPaidSumsForInvoices(
      kindergartenId,
      stale.map((s) => s.id),
    );
    for (const inv of stale) {
      const paid = paidSums.get(inv.id) ?? 0;
      if (paid > 0) {
        return { invoice: inv, paidAmount: paid };
      }
    }
    return null;
  }

  /**
   * §2.8 / review FIX 4 — cancel the unpaid monthlies covered by a freshly
   * SETTLED prepayment, shared by `manualMarkPaid` (cash settlement).
   * Mirrors `PaymentService.cancelMonthliesCoveredByPrepayment` (the
   * gateway settlement hook keeps its own copy so the payment.service spec
   * harness's get-only InvoiceService shim keeps compiling) — keep the two
   * in sync.
   *
   * Guards:
   *   - FIX 6: per-child prepayment advisory lock (reentrant when the
   *     caller already holds it) so a concurrent `prepayInvoice` for the
   *     same child cannot interleave;
   *   - FIX 7: the SAME per-(kg, month) monthly-generation advisory lock
   *     the cron holds, acquired chronologically over the window — the
   *     hook then either sees the committed monthly (and cancels it) or
   *     blocks until the cron finishes;
   *   - FIX 5: money guard — an overlapped monthly with a completed-paid
   *     sum > 0 (whatever its status, covers partial→overdue rows) is
   *     never cancelled, only flagged for manual review (§2.8); and a lost
   *     `markCancelledConditional` flip is re-read — silent only when the
   *     row is already `cancelled`, warned otherwise.
   */
  private async cancelCoveredMonthliesForPrepayment(
    kindergartenId: string,
    prepayment: Invoice,
    now: Date,
  ): Promise<void> {
    await this.invoices.acquireChildPrepaymentAdvisoryLock(
      kindergartenId,
      prepayment.childId,
    );
    for (
      let mStart = prepayment.periodStart;
      mStart.getTime() <= prepayment.periodEnd.getTime();
      mStart = addMonthsUtc(mStart, 1)
    ) {
      await this.invoices.acquireMonthlyGenerationAdvisoryLock(
        kindergartenId,
        mStart,
      );
    }
    const overlapped = await this.invoices.findMonthlyInWindow(
      kindergartenId,
      prepayment.childId,
      prepayment.periodStart,
      prepayment.periodEnd,
    );
    if (overlapped.length === 0) return;
    const paidSums = await this.invoices.getPaidSumsForInvoices(
      kindergartenId,
      overlapped.map((m) => m.id),
    );
    for (const monthly of overlapped) {
      const paidKzt = paidSums.get(monthly.id) ?? 0;
      if (
        monthly.status === 'paid' ||
        monthly.status === 'partial' ||
        paidKzt > 0
      ) {
        this.logger.warn(
          `prepayment.settled: overlapped monthly ${monthly.id} already ${monthly.status}${paidKzt > 0 ? ` (paid_sum=${paidKzt})` : ''} — manual review (no auto-refund), prepayment ${prepayment.id}`,
        );
        continue;
      }
      const cancelled = await this.invoices.markCancelledConditional(
        kindergartenId,
        monthly.id,
        now,
      );
      if (!cancelled) {
        const reread = await this.invoices.findById(kindergartenId, monthly.id);
        if (reread && reread.status !== 'cancelled') {
          this.logger.warn(
            `prepayment.settled: overlapped monthly ${monthly.id} flipped to ${reread.status} mid-hook — manual review (no auto-refund), prepayment ${prepayment.id}`,
          );
        }
        continue;
      }
      await this.releaseCustomDiscountUsagesForInvoice(
        kindergartenId,
        monthly.id,
      );
      this.logger.log(
        `prepayment.settled: cancelled overlapped monthly ${monthly.id} (period ${toIsoDate(monthly.periodStart)}) covered by prepayment ${prepayment.id}`,
      );
      await this.notificationPort.notifyInvoiceCancelled({
        kindergartenId,
        invoiceId: monthly.id,
        childId: monthly.childId,
        reason: 'covered_by_prepayment',
      });
    }
  }

  /**
   * Reverse of the `tryReserveUsage` reservation for a CANCELLED invoice's
   * custom-discount applications — cancelled invoices must not consume
   * capped discount slots (handoff §5.3). The reservation only ever
   * incremented `used_count` for discounts WITH a `total_max_uses` cap
   * (`buildCustomDiscountInputs` guards the `tryReserveUsage` call with
   * `snap.totalMaxUses !== null`), so only those are released here —
   * releasing an uncapped discount would underflow-drift its counter.
   * The insert-only application ledger stays untouched: the per-child cap
   * check (`countByChildAndDiscount`) excludes voided invoices by status
   * instead. Runs in the ambient TX, atomic with the cancel flip.
   */
  private async releaseCustomDiscountUsagesForInvoice(
    kindergartenId: string,
    invoiceId: string,
  ): Promise<void> {
    if (!this.customDiscounts || !this.customDiscountApplications) return;
    const apps = await this.customDiscountApplications.listByInvoiceId(
      kindergartenId,
      invoiceId,
    );
    for (const app of apps) {
      const discount = await this.customDiscounts.findById(
        kindergartenId,
        app.customDiscountId,
      );
      if (!discount || discount.totalMaxUses === null) continue;
      await this.customDiscounts.releaseUsage(
        kindergartenId,
        app.customDiscountId,
      );
      this.logger.debug(
        `discount.reserve_released: kg=${kindergartenId} discount=${app.customDiscountId} — invoice ${invoiceId} cancelled.`,
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

/**
 * Largest-remainder allocation of a whole-tenge `total` across `weights`
 * (per-month billable-day fractions — the shared monthly price cancels out
 * of the base-amount ratio, so day fractions alone carry the exact
 * full-precision weights). Floors first, then one tenge at a time by
 * descending fractional remainder (ties → earlier month), which guarantees
 * `Σ shares === total` exactly (§2.6) — asserted before returning. All-zero
 * weights (every month fully holiday → total is 0) yield all-zero shares.
 */
function distributeWholeTenge(total: MoneyKzt, weights: Decimal[]): MoneyKzt[] {
  const totalKzt = total.toNumber(); // whole after roundToWholeKzt — exact
  const weightSum = weights.reduce((acc, w) => acc.plus(w), new Decimal(0));
  if (weightSum.isZero() || totalKzt === 0) {
    return weights.map(() => MoneyKzt.zero());
  }
  const floors: number[] = [];
  const remainders: Decimal[] = [];
  let floorSum = 0;
  for (const w of weights) {
    const raw = w.mul(totalKzt).div(weightSum);
    const floor = raw.floor();
    floors.push(floor.toNumber());
    remainders.push(raw.minus(floor));
    floorSum += floor.toNumber();
  }
  let leftover = totalKzt - floorSum;
  const order = remainders
    .map((r, i) => ({ r, i }))
    .sort((a, b) => b.r.comparedTo(a.r) || a.i - b.i);
  for (const { i } of order) {
    if (leftover <= 0) break;
    floors[i] += 1;
    leftover -= 1;
  }
  const shares = floors.map((f) => MoneyKzt.fromKzt(f));
  const sum = shares.reduce((acc, s) => acc.add(s), MoneyKzt.zero());
  if (!sum.equals(total)) {
    // Internal invariant (§2.6): line items and calendar rows must add up
    // to exactly what the parent pays. Unreachable by construction.
    throw new Error('prepayment_share_sum_mismatch');
  }
  return shares;
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
