import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
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
import { TariffAssignmentRepository } from './infrastructure/persistence/tariff-assignment.repository';
import { TariffPlanRepository } from './infrastructure/persistence/tariff-plan.repository';
import { HolidayService } from './holiday.service';
import { PaymentAccountService } from './payment-account.service';

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
    @Inject(ClockPort) private readonly clock: ClockPort,
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

    return this.invoices.create(invoice, lineItems);
  }

  // ── Admin actions (state flips) ────────────────────────────────────────

  /**
   * Records an off-platform (cash) payment as a `Payment` row and flips the
   * invoice to `paid`. Idempotent at the conditional-UPDATE level — a 0-row
   * result is mapped to `InvoiceStatusInvalidError` (or
   * `InvoiceAlreadyPaidError` if a follow-up read shows the row is already
   * `paid`).
   *
   * NOTE: the `Payment` row insert is left to T5a (PaymentService). T4a
   * fires only the invoice state flip + payment_account credit. The
   * controller in T7 documents that callers should rely on the audit
   * `note` until T5a's `cash` provider lands.
   */
  async manualMarkPaid(
    kindergartenId: string,
    invoiceId: string,
    _input: ManualMarkPaidInput = {},
  ): Promise<Invoice> {
    const now = this.clock.now();
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
    // Credit the running balance ledger by the residual amount due so the
    // parent app's "amount owed" view drops to zero. Difference between
    // amount-after-discount and existing paid sum is added; sign convention:
    // payments increase balance (running positive = paid in advance, running
    // negative = arrears).
    const paidSum = await this.invoices.getPaidSumForInvoice(
      kindergartenId,
      invoiceId,
    );
    const residual = updated.amountAfterDiscount - paidSum;
    if (residual > 0) {
      await this.paymentAccounts.creditFromPayment(
        kindergartenId,
        updated.paymentAccountId,
        residual,
      );
    }
    return updated;
  }

  async cancel(
    kindergartenId: string,
    invoiceId: string,
    _reason?: string,
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
    return updated;
  }

  // ── Auto-generation ────────────────────────────────────────────────────

  /**
   * Cron-callable. Emits monthly invoices for every active tariff
   * assignment as of `periodStart`. See class-level docstring on the
   * required ambient TX. Idempotent via advisory lock + existsAnyForPeriod
   * short-circuit.
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

    if (await this.invoices.existsAnyForPeriod(kindergartenId, periodStart)) {
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
    return this.invoices.create(invoice, [lineItem]);
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
      amountAfter =
        Math.round(((amountAfter * effectiveBillableDays) / totalDays) * 100) /
        100;
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

    return this.invoices.create(invoice, [lineItem]);
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
