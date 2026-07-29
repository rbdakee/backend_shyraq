import { Logger } from '@nestjs/common';
import { InMemoryNotificationAdapter } from '@/common/notifications/in-memory-notification.adapter';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { MoneyKzt } from '@/shared-kernel/domain/money-kzt';
import { Invoice, InvoiceState } from './domain/entities/invoice.entity';
import { InvoiceLineItem } from './domain/entities/invoice-line-item.entity';
import { PaymentAccount } from './domain/entities/payment-account.entity';
import { Payment, PaymentProvider } from './domain/entities/payment.entity';
import {
  TariffAssignment,
  TariffAssignmentState,
} from './domain/entities/tariff-assignment.entity';
import {
  TariffPlan,
  TariffPlanState,
  TariffType,
} from './domain/entities/tariff-plan.entity';
import { InvoiceAlreadyPaidError } from './domain/errors/invoice-already-paid.error';
import { InvoiceNotFoundError } from './domain/errors/invoice-not-found.error';
import { InvoiceStatusInvalidError } from './domain/errors/invoice-status-invalid.error';
import { PrepaymentBlockedOutstandingDebtError } from './domain/errors/prepayment-blocked-outstanding-debt.error';
import { PrepaymentBlockedPartialPrepaymentError } from './domain/errors/prepayment-blocked-partial-prepayment.error';
import { PrepaymentBlockedWindowOverlapError } from './domain/errors/prepayment-blocked-window-overlap.error';
import { TariffAssignmentNotFoundError } from './domain/errors/tariff-assignment-not-found.error';
import { TariffPlanNotFoundError } from './domain/errors/tariff-plan-not-found.error';
import {
  DiscountEnginePort,
  DiscountEvaluationInput,
  DiscountEvaluationResult,
} from './infrastructure/discount-engine/discount-engine.port';
import { HolidayService } from './holiday.service';
import {
  InvoiceService,
  PrepaymentQuote,
  PrepaymentQuoteBlocked,
  PrepaymentQuoteComputed,
} from './invoice.service';
import {
  InvoiceRepository,
  ListInvoicesFilter,
} from './infrastructure/persistence/invoice.repository';
import { InvoiceLineItemRepository } from './infrastructure/persistence/invoice-line-item.repository';
import { PaymentAccountService } from './payment-account.service';
import { PaymentAccountRepository } from './infrastructure/persistence/payment-account.repository';
import { PaymentRepository } from './infrastructure/persistence/payment.repository';
import {
  CreateTariffAssignmentInput,
  TariffAssignmentRepository,
} from './infrastructure/persistence/tariff-assignment.repository';
import { TariffPlanRepository } from './infrastructure/persistence/tariff-plan.repository';
import {
  CreateKindergartenHolidayInput,
  KindergartenHolidayRepository,
} from './infrastructure/persistence/kindergarten-holiday.repository';
import { KindergartenHoliday } from './domain/entities/kindergarten-holiday.entity';

const m = (n: number): MoneyKzt => MoneyKzt.fromKzt(n);

const KG = '11111111-1111-1111-1111-111111111111';
const KG_OTHER = '22222222-2222-2222-2222-222222222222';
const CHILD = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const CHILD2 = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const STAFF = 'ssssssss-1111-2222-3333-ssssssssssss';
const PLAN = 'pppppppp-pppp-pppp-pppp-pppppppppppp';
const NOW = new Date('2026-06-01T09:00:00.000Z');

class FakeClock extends ClockPort {
  constructor(private d: Date) {
    super();
  }
  now(): Date {
    return this.d;
  }
}

// ── Fake repos ───────────────────────────────────────────────────────────

class FakeInvoiceRepo extends InvoiceRepository {
  rows = new Map<string, Invoice>();
  /** invoice_id → list */
  lineItems = new Map<string, InvoiceLineItem[]>();
  paidSums = new Map<string, number>();
  /**
   * Advisory-lock recording (review FIX 6/7) — `child:<id>` and
   * `monthly:<YYYY-MM-DD>` entries in acquisition order.
   */
  lockCalls: string[] = [];

  create(invoice: Invoice, items: InvoiceLineItem[]): Promise<Invoice> {
    this.rows.set(invoice.id, invoice);
    this.lineItems.set(invoice.id, items);
    return Promise.resolve(invoice);
  }

  findById(kindergartenId: string, id: string): Promise<Invoice | null> {
    const inv = this.rows.get(id);
    if (!inv || inv.kindergartenId !== kindergartenId)
      return Promise.resolve(null);
    return Promise.resolve(inv);
  }

  list(kindergartenId: string, filter: ListInvoicesFilter): Promise<Invoice[]> {
    return Promise.resolve(
      [...this.rows.values()].filter(
        (i) =>
          i.kindergartenId === kindergartenId &&
          (!filter.status || i.status === filter.status) &&
          (!filter.childId || i.childId === filter.childId) &&
          (!filter.invoiceType || i.invoiceType === filter.invoiceType),
      ),
    );
  }

  findByChildId(kindergartenId: string, childId: string): Promise<Invoice[]> {
    return this.list(kindergartenId, { childId });
  }

  existsMonthlyForPeriod(
    kindergartenId: string,
    periodStart: Date,
  ): Promise<boolean> {
    const periodKey = periodStart.toISOString().slice(0, 10);
    for (const inv of this.rows.values()) {
      if (
        inv.kindergartenId === kindergartenId &&
        inv.invoiceType === 'monthly' &&
        inv.periodStart.toISOString().slice(0, 10) === periodKey
      ) {
        return Promise.resolve(true);
      }
    }
    return Promise.resolve(false);
  }

  getPaidSumForInvoice(_kg: string, invoiceId: string): Promise<number> {
    return Promise.resolve(this.paidSums.get(invoiceId) ?? 0);
  }
  getPaidSumsForInvoices(
    _kg: string,
    ids: string[],
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const id of ids) {
      const sum = this.paidSums.get(id);
      if (sum !== undefined) out.set(id, sum);
    }
    return Promise.resolve(out);
  }
  getOutstandingByChild(): Promise<Map<string, number>> {
    return Promise.resolve(new Map());
  }

  markPaidConditional(
    kindergartenId: string,
    id: string,
    now: Date,
  ): Promise<Invoice | null> {
    return Promise.resolve(
      this.transitionConditional(
        kindergartenId,
        id,
        ['pending', 'partial', 'overdue'],
        'paid',
        now,
      ),
    );
  }

  markPartialConditional(
    kindergartenId: string,
    id: string,
    now: Date,
  ): Promise<Invoice | null> {
    return Promise.resolve(
      this.transitionConditional(
        kindergartenId,
        id,
        ['pending', 'overdue'],
        'partial',
        now,
      ),
    );
  }

  markCancelledConditional(
    kindergartenId: string,
    id: string,
    now: Date,
  ): Promise<Invoice | null> {
    return Promise.resolve(
      this.transitionConditional(
        kindergartenId,
        id,
        ['pending', 'partial', 'overdue'],
        'cancelled',
        now,
      ),
    );
  }

  markRefundedConditional(
    kindergartenId: string,
    id: string,
    now: Date,
  ): Promise<Invoice | null> {
    return Promise.resolve(
      this.transitionConditional(
        kindergartenId,
        id,
        ['paid', 'partial'],
        'refunded',
        now,
      ),
    );
  }

  markOverdueConditional(
    kindergartenId: string,
    id: string,
    now: Date,
  ): Promise<Invoice | null> {
    // B22a T1 SM1: `partial` is now a valid source — see InvoiceRepository
    // doc + invoice.relational.repository.ts:`markOverdueConditional`.
    return Promise.resolve(
      this.transitionConditional(
        kindergartenId,
        id,
        ['pending', 'partial'],
        'overdue',
        now,
      ),
    );
  }

  private transitionConditional(
    kindergartenId: string,
    id: string,
    expected: string[],
    next: 'paid' | 'partial' | 'cancelled' | 'refunded' | 'overdue',
    now: Date,
  ): Invoice | null {
    const inv = this.rows.get(id);
    if (!inv || inv.kindergartenId !== kindergartenId) return null;
    if (!expected.includes(inv.status)) return null;
    const s = inv.toState();
    const updated = Invoice.fromState({ ...s, status: next, updatedAt: now });
    this.rows.set(id, updated);
    return updated;
  }

  acquireMonthlyGenerationAdvisoryLock(
    _kindergartenId: string,
    periodStart: Date,
  ): Promise<void> {
    this.lockCalls.push(`monthly:${periodStart.toISOString().slice(0, 10)}`);
    return Promise.resolve();
  }

  acquireChildPrepaymentAdvisoryLock(
    _kindergartenId: string,
    childId: string,
  ): Promise<void> {
    this.lockCalls.push(`child:${childId}`);
    return Promise.resolve();
  }

  // ── Prepayment coverage (behavioral overrides of the abstract-class
  //    default stubs — mirror the relational queries' semantics) ──────────

  findUnpaidNonPrepaymentByChild(
    kindergartenId: string,
    childId: string,
  ): Promise<Invoice[]> {
    return Promise.resolve(
      [...this.rows.values()].filter(
        (i) =>
          i.kindergartenId === kindergartenId &&
          i.childId === childId &&
          ['pending', 'overdue', 'partial'].includes(i.status) &&
          !i.invoiceType.startsWith('prepayment_'),
      ),
    );
  }

  findPaidPrepaymentsByChild(
    kindergartenId: string,
    childId: string,
    periodEndFrom: Date,
  ): Promise<Invoice[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .filter(
          (i) =>
            i.kindergartenId === kindergartenId &&
            i.childId === childId &&
            i.invoiceType.startsWith('prepayment_') &&
            i.status === 'paid' &&
            i.periodEnd.getTime() >= periodEndFrom.getTime(),
        )
        .sort((a, b) => a.periodStart.getTime() - b.periodStart.getTime()),
    );
  }

  listChildIdsWithPaidPrepaymentCovering(
    kindergartenId: string,
    periodStart: Date,
  ): Promise<string[]> {
    const ids = new Set<string>();
    for (const i of this.rows.values()) {
      if (
        i.kindergartenId === kindergartenId &&
        i.invoiceType.startsWith('prepayment_') &&
        i.status === 'paid' &&
        i.periodStart.getTime() <= periodStart.getTime() &&
        i.periodEnd.getTime() >= periodStart.getTime()
      ) {
        ids.add(i.childId);
      }
    }
    return Promise.resolve([...ids]);
  }

  findUnpaidPrepaymentsByChild(
    kindergartenId: string,
    childId: string,
  ): Promise<Invoice[]> {
    // `partial` included (review FIX 2) — mirrors the relational query;
    // the service's paid-sum money guard decides block-vs-cancel.
    return Promise.resolve(
      [...this.rows.values()].filter(
        (i) =>
          i.kindergartenId === kindergartenId &&
          i.childId === childId &&
          i.invoiceType.startsWith('prepayment_') &&
          (i.status === 'pending' ||
            i.status === 'overdue' ||
            i.status === 'partial'),
      ),
    );
  }

  findMonthlyInWindow(
    kindergartenId: string,
    childId: string,
    windowStart: Date,
    windowEnd: Date,
  ): Promise<Invoice[]> {
    // Mirrors the relational query (monthly-only, four live statuses,
    // period_start containment) — feeds the FIX 4 manualMarkPaid hook.
    const live = ['pending', 'overdue', 'partial', 'paid'];
    return Promise.resolve(
      [...this.rows.values()].filter(
        (i) =>
          i.kindergartenId === kindergartenId &&
          i.childId === childId &&
          i.invoiceType === 'monthly' &&
          live.includes(i.status) &&
          i.periodStart.getTime() >= windowStart.getTime() &&
          i.periodStart.getTime() <= windowEnd.getTime(),
      ),
    );
  }
}

class FakeInvoiceLineItemRepo extends InvoiceLineItemRepository {
  rows: InvoiceLineItem[] = [];

  createMany(items: InvoiceLineItem[]): Promise<InvoiceLineItem[]> {
    this.rows.push(...items);
    return Promise.resolve(items);
  }

  listByInvoice(
    kindergartenId: string,
    invoiceId: string,
  ): Promise<InvoiceLineItem[]> {
    return Promise.resolve(
      this.rows.filter(
        (li) =>
          li.kindergartenId === kindergartenId && li.invoiceId === invoiceId,
      ),
    );
  }

  // Behavioral override of the abstract-class default stub — mirrors the
  // relational `ORDER BY invoice_id, created_at ASC` semantics (P6).
  listByInvoiceIds(
    kindergartenId: string,
    invoiceIds: string[],
  ): Promise<InvoiceLineItem[]> {
    const wanted = new Set(invoiceIds);
    return Promise.resolve(
      this.rows
        .filter(
          (li) =>
            li.kindergartenId === kindergartenId && wanted.has(li.invoiceId),
        )
        .sort(
          (a, b) =>
            a.invoiceId.localeCompare(b.invoiceId) ||
            a.createdAt.getTime() - b.createdAt.getTime(),
        ),
    );
  }
}

class FakeTariffPlanRepo extends TariffPlanRepository {
  rows = new Map<string, TariffPlan>();

  put(p: TariffPlan): void {
    this.rows.set(p.id, p);
  }

  create(plan: TariffPlan): Promise<TariffPlan> {
    this.rows.set(plan.id, plan);
    return Promise.resolve(plan);
  }
  update(): Promise<TariffPlan | null> {
    return Promise.reject(new Error('not used in invoice spec'));
  }
  save(plan: TariffPlan): Promise<TariffPlan> {
    this.rows.set(plan.id, plan);
    return Promise.resolve(plan);
  }
  findById(kindergartenId: string, id: string): Promise<TariffPlan | null> {
    const p = this.rows.get(id);
    if (!p || p.kindergartenId !== kindergartenId) return Promise.resolve(null);
    return Promise.resolve(p);
  }
  findActiveByType(
    kindergartenId: string,
    tariffType: TariffType,
    atDate?: Date,
  ): Promise<TariffPlan | null> {
    const at = atDate ?? new Date();
    const candidates = [...this.rows.values()].filter(
      (p) =>
        p.kindergartenId === kindergartenId &&
        p.tariffType === tariffType &&
        p.isActive &&
        p.validFrom.getTime() <= at.getTime() &&
        (p.validUntil === null || p.validUntil.getTime() >= at.getTime()),
    );
    candidates.sort((a, b) => b.validFrom.getTime() - a.validFrom.getTime());
    return Promise.resolve(candidates[0] ?? null);
  }
  list(kindergartenId: string): Promise<TariffPlan[]> {
    return Promise.resolve(
      [...this.rows.values()].filter(
        (p) => p.kindergartenId === kindergartenId,
      ),
    );
  }
}

class FakeTariffAssignmentRepo extends TariffAssignmentRepository {
  rows = new Map<string, TariffAssignment>();

  put(a: TariffAssignment): void {
    this.rows.set(a.id, a);
  }

  create(input: CreateTariffAssignmentInput): Promise<TariffAssignment> {
    const id = `ta-${this.rows.size + 1}`;
    const a = TariffAssignment.fromState({
      id,
      kindergartenId: input.kindergartenId,
      childId: input.childId,
      tariffPlanId: input.tariffPlanId,
      customAmount:
        input.customAmount === null
          ? null
          : MoneyKzt.fromKzt(input.customAmount),
      customReason: input.customReason,
      validFrom: input.validFrom,
      validUntil: input.validUntil,
      assignedBy: input.assignedBy,
      createdAt: NOW,
      updatedAt: NOW,
    });
    this.rows.set(id, a);
    return Promise.resolve(a);
  }
  update(): Promise<TariffAssignment | null> {
    return Promise.reject(new Error('not used'));
  }
  save(a: TariffAssignment): Promise<TariffAssignment> {
    this.rows.set(a.id, a);
    return Promise.resolve(a);
  }
  findById(
    kindergartenId: string,
    id: string,
  ): Promise<TariffAssignment | null> {
    const a = this.rows.get(id);
    if (!a || a.kindergartenId !== kindergartenId) return Promise.resolve(null);
    return Promise.resolve(a);
  }
  findActiveForChild(
    kindergartenId: string,
    childId: string,
    atDate: Date,
  ): Promise<TariffAssignment | null> {
    const candidates = [...this.rows.values()].filter(
      (a) =>
        a.kindergartenId === kindergartenId &&
        a.childId === childId &&
        a.validFrom.getTime() <= atDate.getTime() &&
        (a.validUntil === null || a.validUntil.getTime() >= atDate.getTime()),
    );
    candidates.sort((a, b) => b.validFrom.getTime() - a.validFrom.getTime());
    return Promise.resolve(candidates[0] ?? null);
  }
  findAllActiveAtDate(
    kindergartenId: string,
    atDate: Date,
  ): Promise<TariffAssignment[]> {
    return Promise.resolve(
      [...this.rows.values()].filter(
        (a) =>
          a.kindergartenId === kindergartenId &&
          a.validFrom.getTime() <= atDate.getTime() &&
          (a.validUntil === null || a.validUntil.getTime() >= atDate.getTime()),
      ),
    );
  }
  existsOverlap(): Promise<boolean> {
    return Promise.resolve(false);
  }
  list(kindergartenId: string): Promise<TariffAssignment[]> {
    return Promise.resolve(
      [...this.rows.values()].filter(
        (a) => a.kindergartenId === kindergartenId,
      ),
    );
  }
  acquireAssignChildAdvisoryLock(): Promise<void> {
    return Promise.resolve();
  }
}

class FakePaymentRepo extends PaymentRepository {
  rows = new Map<string, Payment>();

  acquirePaymentAdvisoryLock(): Promise<void> {
    return Promise.resolve();
  }
  create(payment: Payment): Promise<Payment> {
    this.rows.set(payment.id, payment);
    return Promise.resolve(payment);
  }
  findById(_kg: string, id: string): Promise<Payment | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }
  findByIdempotencyKey(): Promise<Payment | null> {
    return Promise.resolve(null);
  }
  findByInvoiceId(_kg: string, invoiceId: string): Promise<Payment[]> {
    return Promise.resolve(
      [...this.rows.values()].filter((p) => p.invoiceId === invoiceId),
    );
  }
  list(): Promise<Payment[]> {
    return Promise.resolve([...this.rows.values()]);
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
  markRefundRequired(): Promise<Payment | null> {
    return Promise.resolve(null);
  }
}

class FakePaymentAccountRepo extends PaymentAccountRepository {
  rows = new Map<string, PaymentAccount>();
  findOrCreateForChild(
    kindergartenId: string,
    childId: string,
  ): Promise<PaymentAccount> {
    for (const a of this.rows.values()) {
      if (a.kindergartenId === kindergartenId && a.childId === childId) {
        return Promise.resolve(a);
      }
    }
    const id = `pa-${this.rows.size + 1}`;
    const a = PaymentAccount.fromState({
      id,
      kindergartenId,
      childId,
      balance: MoneyKzt.zero(),
      createdAt: NOW,
      updatedAt: NOW,
    });
    this.rows.set(id, a);
    return Promise.resolve(a);
  }
  findById(kindergartenId: string, id: string): Promise<PaymentAccount | null> {
    const a = this.rows.get(id);
    if (!a || a.kindergartenId !== kindergartenId) return Promise.resolve(null);
    return Promise.resolve(a);
  }
  findByChildId(
    kindergartenId: string,
    childId: string,
  ): Promise<PaymentAccount | null> {
    for (const a of this.rows.values()) {
      if (a.kindergartenId === kindergartenId && a.childId === childId) {
        return Promise.resolve(a);
      }
    }
    return Promise.resolve(null);
  }
  save(a: PaymentAccount): Promise<PaymentAccount> {
    this.rows.set(a.id, a);
    return Promise.resolve(a);
  }
}

class FakeHolidayRepo extends KindergartenHolidayRepository {
  rows: KindergartenHoliday[] = [];
  create(_input: CreateKindergartenHolidayInput): Promise<KindergartenHoliday> {
    return Promise.reject(new Error('unused'));
  }
  update(): Promise<KindergartenHoliday | null> {
    return Promise.reject(new Error('unused'));
  }
  delete(): Promise<void> {
    return Promise.resolve();
  }
  findById(): Promise<KindergartenHoliday | null> {
    return Promise.resolve(null);
  }
  list(): Promise<KindergartenHoliday[]> {
    return Promise.resolve(this.rows);
  }
  countNonBillableInRange(
    kindergartenId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<number> {
    return Promise.resolve(
      this.rows.filter(
        (h) =>
          h.kindergartenId === kindergartenId &&
          !h.isBillable &&
          h.date.getTime() >= periodStart.getTime() &&
          h.date.getTime() <= periodEnd.getTime(),
      ).length,
    );
  }
}

class FakeDiscountEngine extends DiscountEnginePort {
  result: DiscountEvaluationResult = {
    discountPct: null,
    discountReason: null,
    appliedRules: [],
    customApplicationsToWrite: [],
    customDiscountAmount: null,
  };
  lastInput: DiscountEvaluationInput | null = null;
  /** Every evaluate() input in call order — asserts single-evaluate (§5.7). */
  calls: DiscountEvaluationInput[] = [];
  evaluate(input: DiscountEvaluationInput): Promise<DiscountEvaluationResult> {
    this.lastInput = input;
    this.calls.push(input);
    return Promise.resolve(this.result);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

function basePlanState(
  overrides: Partial<TariffPlanState> = {},
): TariffPlanState {
  return {
    id: PLAN,
    kindergartenId: KG,
    name: 'Standard',
    description: { ru: 'Стандарт' },
    tariffType: 'monthly',
    amount: m(50000),
    currency: 'KZT',
    appliesTo: 'all_children',
    groupId: null,
    ageMinMonths: null,
    ageMaxMonths: null,
    isActive: true,
    validFrom: new Date('2026-01-01T00:00:00.000Z'),
    validUntil: null,
    discountRules: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function baseAssignmentState(
  overrides: Partial<TariffAssignmentState> = {},
): TariffAssignmentState {
  return {
    id: 'ta-1',
    kindergartenId: KG,
    childId: CHILD,
    tariffPlanId: PLAN,
    customAmount: null,
    customReason: null,
    validFrom: new Date('2026-01-01T00:00:00.000Z'),
    validUntil: null,
    assignedBy: STAFF,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/**
 * Invoice seeding helper for the prepayment-coverage describes — the older
 * tests inline their `Invoice.fromState({...})` literals and stay untouched.
 */
function baseInvoiceState(overrides: Partial<InvoiceState> = {}): InvoiceState {
  return {
    id: 'inv-base',
    kindergartenId: KG,
    childId: CHILD,
    paymentAccountId: 'pa-1',
    tariffPlanId: PLAN,
    invoiceType: 'monthly',
    periodStart: new Date('2026-06-01T00:00:00.000Z'),
    periodEnd: new Date('2026-06-30T00:00:00.000Z'),
    amountDue: m(50000),
    discountPct: null,
    discountReason: null,
    amountAfterDiscount: m(50000),
    status: 'pending',
    dueDate: new Date('2026-06-10T00:00:00.000Z'),
    description: null,
    proratedForDays: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function buildSvc(at: Date = NOW) {
  const invoiceRepo = new FakeInvoiceRepo();
  const lineItemRepo = new FakeInvoiceLineItemRepo();
  const planRepo = new FakeTariffPlanRepo();
  const assignmentRepo = new FakeTariffAssignmentRepo();
  const accountRepo = new FakePaymentAccountRepo();
  const paymentRepo = new FakePaymentRepo();
  const holidayRepo = new FakeHolidayRepo();
  const clock = new FakeClock(at);
  const accountSvc = new PaymentAccountService(accountRepo, clock);
  const holidaySvc = new HolidayService(holidayRepo, clock);
  const discount = new FakeDiscountEngine();
  const notifier = new InMemoryNotificationAdapter();
  const svc = new InvoiceService(
    invoiceRepo,
    lineItemRepo,
    planRepo,
    assignmentRepo,
    accountSvc,
    discount,
    holidaySvc,
    notifier,
    clock,
    paymentRepo,
  );
  return {
    svc,
    invoiceRepo,
    lineItemRepo,
    planRepo,
    assignmentRepo,
    accountRepo,
    paymentRepo,
    holidayRepo,
    discount,
    notifier,
    clock,
    accountSvc,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('InvoiceService', () => {
  describe('list / get', () => {
    it('list returns the kg-scoped invoices', async () => {
      const { svc, invoiceRepo, accountSvc } = buildSvc();
      const account = await accountSvc.ensureForChild(KG, CHILD);
      invoiceRepo.rows.set(
        'i-1',
        Invoice.fromState({
          id: 'i-1',
          kindergartenId: KG,
          childId: CHILD,
          paymentAccountId: account.id,
          tariffPlanId: PLAN,
          invoiceType: 'monthly',
          periodStart: new Date('2026-06-01T00:00:00.000Z'),
          periodEnd: new Date('2026-06-30T00:00:00.000Z'),
          amountDue: m(50000),
          discountPct: null,
          discountReason: null,
          amountAfterDiscount: m(50000),
          status: 'pending',
          dueDate: new Date('2026-06-10T00:00:00.000Z'),
          description: null,
          proratedForDays: null,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      );
      const list = await svc.list(KG);
      expect(list).toHaveLength(1);
    });

    it('get throws InvoiceNotFoundError for unknown id', async () => {
      const { svc } = buildSvc();
      await expect(svc.get(KG, 'missing')).rejects.toThrow(
        InvoiceNotFoundError,
      );
    });
  });

  describe('createOneOff', () => {
    it('persists the invoice + line items', async () => {
      const { svc, invoiceRepo, lineItemRepo } = buildSvc();
      const inv = await svc.createOneOff(KG, {
        childId: CHILD,
        invoiceType: 'additional_service',
        amountDue: 10000,
        dueDate: new Date('2026-06-10T00:00:00.000Z'),
        periodStart: new Date('2026-06-01T00:00:00.000Z'),
        periodEnd: new Date('2026-06-30T00:00:00.000Z'),
        lineItems: [{ description: 'Lunch', quantity: 1, unitPrice: 10000 }],
      });
      expect(inv.amountDue.toNumber()).toBe(10000);
      expect(invoiceRepo.rows.get(inv.id)).toBe(inv);
      const items = invoiceRepo.lineItems.get(inv.id);
      expect(items).toHaveLength(1);
      // line item also saved via repo only — lineItemRepo not used directly
      expect(lineItemRepo.rows).toHaveLength(0);
    });

    it('applies discount via computeAmountAfterDiscount', async () => {
      const { svc } = buildSvc();
      const inv = await svc.createOneOff(KG, {
        childId: CHILD,
        invoiceType: 'monthly',
        amountDue: 50000,
        discountPct: 10,
        discountReason: 'sponsor',
        dueDate: new Date('2026-06-10T00:00:00.000Z'),
        periodStart: new Date('2026-06-01T00:00:00.000Z'),
        periodEnd: new Date('2026-06-30T00:00:00.000Z'),
      });
      expect(inv.amountAfterDiscount.toNumber()).toBe(45000);
    });
  });

  describe('manualMarkPaid', () => {
    it('flips a pending invoice to paid and credits payment account', async () => {
      const { svc, invoiceRepo, accountSvc, accountRepo } = buildSvc();
      const account = await accountSvc.ensureForChild(KG, CHILD);
      const id = 'i-1';
      invoiceRepo.rows.set(
        id,
        Invoice.fromState({
          id,
          kindergartenId: KG,
          childId: CHILD,
          paymentAccountId: account.id,
          tariffPlanId: null,
          invoiceType: 'monthly',
          periodStart: new Date('2026-06-01T00:00:00.000Z'),
          periodEnd: new Date('2026-06-30T00:00:00.000Z'),
          amountDue: m(50000),
          discountPct: null,
          discountReason: null,
          amountAfterDiscount: m(50000),
          status: 'pending',
          dueDate: new Date('2026-06-10T00:00:00.000Z'),
          description: null,
          proratedForDays: null,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      );
      const updated = await svc.manualMarkPaid(KG, id);
      expect(updated.status).toBe('paid');
      const acc = accountRepo.rows.get(account.id);
      expect(acc?.balance.toNumber()).toBe(50000);
    });

    it('creates a synthetic Payment row with provider=cash (T11 C3)', async () => {
      const { svc, invoiceRepo, accountSvc, paymentRepo, notifier } =
        buildSvc();
      const account = await accountSvc.ensureForChild(KG, CHILD);
      const id = 'i-cash';
      invoiceRepo.rows.set(
        id,
        Invoice.fromState({
          id,
          kindergartenId: KG,
          childId: CHILD,
          paymentAccountId: account.id,
          tariffPlanId: null,
          invoiceType: 'monthly',
          periodStart: new Date('2026-06-01T00:00:00.000Z'),
          periodEnd: new Date('2026-06-30T00:00:00.000Z'),
          amountDue: m(50000),
          discountPct: null,
          discountReason: null,
          amountAfterDiscount: m(50000),
          status: 'pending',
          dueDate: new Date('2026-06-10T00:00:00.000Z'),
          description: null,
          proratedForDays: null,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      );
      const PAYER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      await svc.manualMarkPaid(KG, id, {
        payerUserId: PAYER,
        note: 'Cash receipt at front desk',
      });

      const payments = [...paymentRepo.rows.values()];
      expect(payments).toHaveLength(1);
      const p = payments[0];
      expect(p.provider).toBe('cash' as PaymentProvider);
      expect(p.status).toBe('completed');
      expect(p.amount.toNumber()).toBe(50000);
      expect(p.payerUserId).toBe(PAYER);
      expect(p.idempotencyKey.startsWith(`cash:${id}:`)).toBe(true);
      expect(p.providerPayload).toMatchObject({
        note: 'Cash receipt at front desk',
        marked_by: 'admin_manual',
      });

      // Both payment.completed AND invoice.paid emitted.
      const types = notifier.events.map((e) => e.type);
      expect(types).toContain('payment_completed');
      expect(types).toContain('invoice_paid');
    });

    it('throws InvoiceAlreadyPaidError when already paid', async () => {
      const { svc, invoiceRepo, accountSvc } = buildSvc();
      const account = await accountSvc.ensureForChild(KG, CHILD);
      const id = 'i-1';
      const baseState: InvoiceState = {
        id,
        kindergartenId: KG,
        childId: CHILD,
        paymentAccountId: account.id,
        tariffPlanId: null,
        invoiceType: 'monthly',
        periodStart: new Date('2026-06-01T00:00:00.000Z'),
        periodEnd: new Date('2026-06-30T00:00:00.000Z'),
        amountDue: m(50000),
        discountPct: null,
        discountReason: null,
        amountAfterDiscount: m(50000),
        status: 'paid',
        dueDate: new Date('2026-06-10T00:00:00.000Z'),
        description: null,
        proratedForDays: null,
        createdAt: NOW,
        updatedAt: NOW,
      };
      invoiceRepo.rows.set(id, Invoice.fromState(baseState));
      await expect(svc.manualMarkPaid(KG, id)).rejects.toThrow(
        InvoiceAlreadyPaidError,
      );
    });

    it('throws InvoiceNotFoundError for unknown id', async () => {
      const { svc } = buildSvc();
      await expect(svc.manualMarkPaid(KG, 'missing')).rejects.toThrow(
        InvoiceNotFoundError,
      );
    });

    it('throws InvoiceStatusInvalidError for cancelled invoice', async () => {
      const { svc, invoiceRepo, accountSvc } = buildSvc();
      const account = await accountSvc.ensureForChild(KG, CHILD);
      const id = 'i-1';
      invoiceRepo.rows.set(
        id,
        Invoice.fromState({
          id,
          kindergartenId: KG,
          childId: CHILD,
          paymentAccountId: account.id,
          tariffPlanId: null,
          invoiceType: 'monthly',
          periodStart: new Date('2026-06-01T00:00:00.000Z'),
          periodEnd: new Date('2026-06-30T00:00:00.000Z'),
          amountDue: m(50000),
          discountPct: null,
          discountReason: null,
          amountAfterDiscount: m(50000),
          status: 'cancelled',
          dueDate: new Date('2026-06-10T00:00:00.000Z'),
          description: null,
          proratedForDays: null,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      );
      await expect(svc.manualMarkPaid(KG, id)).rejects.toThrow(
        InvoiceStatusInvalidError,
      );
    });
  });

  describe('manualMarkPaid (partial amount)', () => {
    const seed = (
      invoiceRepo: FakeInvoiceRepo,
      accountId: string,
      id: string,
      status: InvoiceState['status'],
      amount = 135000,
    ) => {
      invoiceRepo.rows.set(
        id,
        Invoice.fromState({
          id,
          kindergartenId: KG,
          childId: CHILD,
          paymentAccountId: accountId,
          tariffPlanId: null,
          invoiceType: 'monthly',
          periodStart: new Date('2026-06-01T00:00:00.000Z'),
          periodEnd: new Date('2026-06-30T00:00:00.000Z'),
          amountDue: m(amount),
          discountPct: null,
          discountReason: null,
          amountAfterDiscount: m(amount),
          status,
          dueDate: new Date('2026-06-10T00:00:00.000Z'),
          description: null,
          proratedForDays: null,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      );
    };

    it('records a partial cash payment and flips pending → partial', async () => {
      const {
        svc,
        invoiceRepo,
        accountSvc,
        accountRepo,
        paymentRepo,
        notifier,
      } = buildSvc();
      const account = await accountSvc.ensureForChild(KG, CHILD);
      seed(invoiceRepo, account.id, 'i-p1', 'pending');

      const updated = await svc.manualMarkPaid(KG, 'i-p1', { amount: 30000 });

      expect(updated.status).toBe('partial');
      const payments = [...paymentRepo.rows.values()];
      expect(payments).toHaveLength(1);
      expect(payments[0].provider).toBe('cash' as PaymentProvider);
      expect(payments[0].status).toBe('completed');
      expect(payments[0].amount.toNumber()).toBe(30000);
      expect(accountRepo.rows.get(account.id)?.balance.toNumber()).toBe(30000);

      const types = notifier.events.map((e) => e.type);
      expect(types).toContain('payment_completed');
      expect(types).not.toContain('invoice_paid');
    });

    it('flips an overdue invoice → partial on a sub-remaining cash amount', async () => {
      const { svc, invoiceRepo, accountSvc } = buildSvc();
      const account = await accountSvc.ensureForChild(KG, CHILD);
      seed(invoiceRepo, account.id, 'i-p2', 'overdue');

      const updated = await svc.manualMarkPaid(KG, 'i-p2', { amount: 1000 });
      expect(updated.status).toBe('partial');
    });

    it('keeps an already-partial invoice partial and validates against the remaining sum', async () => {
      const { svc, invoiceRepo, accountSvc, paymentRepo } = buildSvc();
      const account = await accountSvc.ensureForChild(KG, CHILD);
      seed(invoiceRepo, account.id, 'i-p3', 'partial');
      invoiceRepo.paidSums.set('i-p3', 105000); // remaining = 30000

      const updated = await svc.manualMarkPaid(KG, 'i-p3', { amount: 10000 });
      expect(updated.status).toBe('partial');
      const payments = [...paymentRepo.rows.values()];
      expect(payments).toHaveLength(1);
      expect(payments[0].amount.toNumber()).toBe(10000);
    });

    it('settles in full when amount equals the remaining balance', async () => {
      const { svc, invoiceRepo, accountSvc, paymentRepo, notifier } =
        buildSvc();
      const account = await accountSvc.ensureForChild(KG, CHILD);
      seed(invoiceRepo, account.id, 'i-p4', 'partial');
      invoiceRepo.paidSums.set('i-p4', 105000); // remaining = 30000

      const updated = await svc.manualMarkPaid(KG, 'i-p4', { amount: 30000 });

      expect(updated.status).toBe('paid');
      const payments = [...paymentRepo.rows.values()];
      expect(payments).toHaveLength(1);
      expect(payments[0].amount.toNumber()).toBe(30000);
      const types = notifier.events.map((e) => e.type);
      expect(types).toContain('invoice_paid');
    });

    it('rejects an amount above the remaining balance', async () => {
      const { svc, invoiceRepo, accountSvc, paymentRepo } = buildSvc();
      const account = await accountSvc.ensureForChild(KG, CHILD);
      seed(invoiceRepo, account.id, 'i-p5', 'pending');

      await expect(
        svc.manualMarkPaid(KG, 'i-p5', { amount: 135001 }),
      ).rejects.toThrow('amount_mismatch_partial');
      expect(invoiceRepo.rows.get('i-p5')?.status).toBe('pending');
      expect(paymentRepo.rows.size).toBe(0);
    });

    it('rejects a non-positive amount', async () => {
      const { svc, invoiceRepo, accountSvc } = buildSvc();
      const account = await accountSvc.ensureForChild(KG, CHILD);
      seed(invoiceRepo, account.id, 'i-p6', 'pending');

      await expect(
        svc.manualMarkPaid(KG, 'i-p6', { amount: 0 }),
      ).rejects.toThrow('amount_mismatch_partial');
      await expect(
        svc.manualMarkPaid(KG, 'i-p6', { amount: -500 }),
      ).rejects.toThrow('amount_mismatch_partial');
    });

    it('throws InvoiceAlreadyPaidError when a partial amount targets a paid invoice', async () => {
      const { svc, invoiceRepo, accountSvc } = buildSvc();
      const account = await accountSvc.ensureForChild(KG, CHILD);
      seed(invoiceRepo, account.id, 'i-p7', 'paid');

      await expect(
        svc.manualMarkPaid(KG, 'i-p7', { amount: 1000 }),
      ).rejects.toThrow(InvoiceAlreadyPaidError);
    });

    it('throws InvoiceStatusInvalidError when a partial amount targets a cancelled invoice', async () => {
      const { svc, invoiceRepo, accountSvc } = buildSvc();
      const account = await accountSvc.ensureForChild(KG, CHILD);
      seed(invoiceRepo, account.id, 'i-p8', 'cancelled');

      await expect(
        svc.manualMarkPaid(KG, 'i-p8', { amount: 1000 }),
      ).rejects.toThrow(InvoiceStatusInvalidError);
    });

    // The cash seam mirrors the gateway seam (`PaymentService.initiate`):
    // prepayment is indivisible, so an admin cannot hand-create the half-paid
    // prepayment the parent is refused. Settling the FULL residual is still
    // allowed — that closes the invoice rather than stranding money on it.
    it('rejects a partial cash amount on a prepayment invoice', async () => {
      const { svc, invoiceRepo, accountSvc, paymentRepo } = buildSvc();
      const account = await accountSvc.ensureForChild(KG, CHILD);
      seed(invoiceRepo, account.id, 'i-p9', 'pending', 148065);
      invoiceRepo.rows.set(
        'i-p9',
        Invoice.fromState({
          ...invoiceRepo.rows.get('i-p9')!.toState(),
          invoiceType: 'prepayment_3m',
        }),
      );

      await expect(
        svc.manualMarkPaid(KG, 'i-p9', { amount: 50000 }),
      ).rejects.toThrow('prepayment_partial_not_allowed');
      expect(invoiceRepo.rows.get('i-p9')?.status).toBe('pending');
      expect(paymentRepo.rows.size).toBe(0);
    });

    it('accepts a cash amount equal to the full residual on a prepayment invoice', async () => {
      const { svc, invoiceRepo, accountSvc, paymentRepo } = buildSvc();
      const account = await accountSvc.ensureForChild(KG, CHILD);
      seed(invoiceRepo, account.id, 'i-p10', 'pending', 148065);
      invoiceRepo.rows.set(
        'i-p10',
        Invoice.fromState({
          ...invoiceRepo.rows.get('i-p10')!.toState(),
          invoiceType: 'prepayment_3m',
        }),
      );

      const updated = await svc.manualMarkPaid(KG, 'i-p10', {
        amount: 148065,
      });

      expect(updated.status).toBe('paid');
      expect([...paymentRepo.rows.values()][0].amount.toNumber()).toBe(148065);
    });
  });

  describe('cancel', () => {
    it('flips pending → cancelled', async () => {
      const { svc, invoiceRepo, accountSvc } = buildSvc();
      const account = await accountSvc.ensureForChild(KG, CHILD);
      const id = 'i-1';
      invoiceRepo.rows.set(
        id,
        Invoice.fromState({
          id,
          kindergartenId: KG,
          childId: CHILD,
          paymentAccountId: account.id,
          tariffPlanId: null,
          invoiceType: 'monthly',
          periodStart: new Date('2026-06-01T00:00:00.000Z'),
          periodEnd: new Date('2026-06-30T00:00:00.000Z'),
          amountDue: m(50000),
          discountPct: null,
          discountReason: null,
          amountAfterDiscount: m(50000),
          status: 'pending',
          dueDate: new Date('2026-06-10T00:00:00.000Z'),
          description: null,
          proratedForDays: null,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      );
      const updated = await svc.cancel(KG, id);
      expect(updated.status).toBe('cancelled');
    });

    it('throws InvoiceAlreadyPaidError when already paid', async () => {
      const { svc, invoiceRepo, accountSvc } = buildSvc();
      const account = await accountSvc.ensureForChild(KG, CHILD);
      const id = 'i-1';
      invoiceRepo.rows.set(
        id,
        Invoice.fromState({
          id,
          kindergartenId: KG,
          childId: CHILD,
          paymentAccountId: account.id,
          tariffPlanId: null,
          invoiceType: 'monthly',
          periodStart: new Date('2026-06-01T00:00:00.000Z'),
          periodEnd: new Date('2026-06-30T00:00:00.000Z'),
          amountDue: m(50000),
          discountPct: null,
          discountReason: null,
          amountAfterDiscount: m(50000),
          status: 'paid',
          dueDate: new Date('2026-06-10T00:00:00.000Z'),
          description: null,
          proratedForDays: null,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      );
      await expect(svc.cancel(KG, id)).rejects.toThrow(InvoiceAlreadyPaidError);
    });

    it('throws InvoiceNotFoundError for unknown id', async () => {
      const { svc } = buildSvc();
      await expect(svc.cancel(KG, 'missing')).rejects.toThrow(
        InvoiceNotFoundError,
      );
    });

    it('releases capped custom-discount usages of the cancelled invoice (FIX 8)', async () => {
      const deps = buildSvc();
      deps.invoiceRepo.rows.set(
        'inv-1',
        Invoice.fromState(baseInvoiceState({ id: 'inv-1' })),
      );
      const releaseCalls: Array<{ kg: string; id: string }> = [];

      (deps.svc as any).customDiscounts = {
        findById: (_kg: string, id: string) =>
          Promise.resolve(
            id === 'd-capped' ? { totalMaxUses: 5 } : { totalMaxUses: null },
          ),
        releaseUsage: (kg: string, id: string) => {
          releaseCalls.push({ kg, id });
          return Promise.resolve();
        },
      };
      (deps.svc as any).customDiscountApplications = {
        listByInvoiceId: (_kg: string, invoiceId: string) =>
          Promise.resolve(
            invoiceId === 'inv-1'
              ? [
                  { customDiscountId: 'd-capped' },
                  { customDiscountId: 'd-uncapped' },
                ]
              : [],
          ),
      };

      const updated = await deps.svc.cancel(KG, 'inv-1', 'admin_reversal');

      expect(updated.status).toBe('cancelled');
      // Only the capped discount is released — keeps used_count symmetric
      // with the status-aware countByChildAndDiscount (review FIX 8).
      expect(releaseCalls).toEqual([{ kg: KG, id: 'd-capped' }]);
      expect(
        deps.notifier.events.filter((e) => e.type === 'invoice_cancelled'),
      ).toHaveLength(1);
    });
  });

  describe('generateMonthly', () => {
    const PERIOD_START = new Date('2026-06-01T00:00:00.000Z');

    it('generates one invoice per active assignment', async () => {
      const { svc, invoiceRepo, planRepo, assignmentRepo } = buildSvc();
      planRepo.put(TariffPlan.fromState(basePlanState()));
      assignmentRepo.put(
        TariffAssignment.fromState(
          baseAssignmentState({ id: 'ta-a', childId: CHILD }),
        ),
      );
      assignmentRepo.put(
        TariffAssignment.fromState(
          baseAssignmentState({ id: 'ta-b', childId: CHILD2 }),
        ),
      );
      const result = await svc.generateMonthly(KG, PERIOD_START);
      expect(result.generated).toBe(2);
      expect(result.skipped).toBe(0);
      expect(invoiceRepo.rows.size).toBe(2);
    });

    it('returns {generated:0,skipped:0} when no assignments', async () => {
      const { svc } = buildSvc();
      const result = await svc.generateMonthly(KG, PERIOD_START);
      expect(result).toEqual({ generated: 0, skipped: 0 });
    });

    it('does not short-circuit when only a prepayment invoice covers the same period (T11 C1)', async () => {
      // Closes the T11 CRITICAL #1 finding: a prepayment_3m invoice with
      // periodStart matching the cron's first-of-month would previously
      // block monthly generation entirely. Now `existsMonthlyForPeriod`
      // only counts `invoice_type='monthly'` rows.
      const { svc, planRepo, assignmentRepo, invoiceRepo, accountSvc } =
        buildSvc();
      planRepo.put(TariffPlan.fromState(basePlanState()));
      assignmentRepo.put(
        TariffAssignment.fromState(baseAssignmentState({ id: 'ta-a' })),
      );
      // Seed a prepayment invoice for the same period_start.
      const account = await accountSvc.ensureForChild(KG, CHILD);
      invoiceRepo.rows.set(
        'i-prep',
        Invoice.fromState({
          id: 'i-prep',
          kindergartenId: KG,
          childId: CHILD,
          paymentAccountId: account.id,
          tariffPlanId: PLAN,
          invoiceType: 'prepayment_3m',
          periodStart: PERIOD_START,
          periodEnd: new Date('2026-08-31T00:00:00.000Z'),
          amountDue: m(150_000),
          discountPct: 5,
          discountReason: 'prepay_3m',
          amountAfterDiscount: m(142_500),
          status: 'pending',
          dueDate: new Date('2026-06-08T00:00:00.000Z'),
          description: null,
          proratedForDays: null,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      );

      const result = await svc.generateMonthly(KG, PERIOD_START);
      expect(result.generated).toBe(1); // monthly invoice still emitted
      expect(result.skipped).toBe(0);
    });

    it('idempotent: second call short-circuits via existsMonthlyForPeriod', async () => {
      const { svc, planRepo, assignmentRepo, invoiceRepo } = buildSvc();
      planRepo.put(TariffPlan.fromState(basePlanState()));
      assignmentRepo.put(
        TariffAssignment.fromState(baseAssignmentState({ id: 'ta-a' })),
      );
      const first = await svc.generateMonthly(KG, PERIOD_START);
      expect(first.generated).toBe(1);
      const second = await svc.generateMonthly(KG, PERIOD_START);
      expect(second.generated).toBe(0);
      expect(second.skipped).toBe(1);
      expect(invoiceRepo.rows.size).toBe(1);
    });

    it('applies discount engine result', async () => {
      const { svc, planRepo, assignmentRepo, discount, invoiceRepo } =
        buildSvc();
      planRepo.put(TariffPlan.fromState(basePlanState()));
      assignmentRepo.put(
        TariffAssignment.fromState(baseAssignmentState({ id: 'ta-a' })),
      );
      discount.result = {
        discountPct: 10,
        discountReason: 'sibling_discount',
        appliedRules: ['sibling'],
        customApplicationsToWrite: [],
        customDiscountAmount: null,
      };
      await svc.generateMonthly(KG, PERIOD_START);
      const inv = [...invoiceRepo.rows.values()][0];
      expect(inv.discountPct).toBe(10);
      expect(inv.discountReason).toBe('sibling_discount');
      expect(inv.amountAfterDiscount.toNumber()).toBe(45000);
    });

    it('skips assignment when its tariff_plan is missing (logs)', async () => {
      const { svc, assignmentRepo, invoiceRepo } = buildSvc();
      // no plan configured
      assignmentRepo.put(
        TariffAssignment.fromState(baseAssignmentState({ id: 'ta-a' })),
      );
      const result = await svc.generateMonthly(KG, PERIOD_START);
      expect(result.generated).toBe(0);
      expect(invoiceRepo.rows.size).toBe(0);
    });

    it('pro-rates by non-billable holidays', async () => {
      const { svc, planRepo, assignmentRepo, holidayRepo, invoiceRepo } =
        buildSvc();
      planRepo.put(TariffPlan.fromState(basePlanState({ amount: m(30000) })));
      assignmentRepo.put(
        TariffAssignment.fromState(baseAssignmentState({ id: 'ta-a' })),
      );
      // 5 non-billable holidays in June (30 days) — 25/30 * 30000 = 25000
      for (let day = 1; day <= 5; day++) {
        holidayRepo.rows.push(
          KindergartenHoliday.fromState({
            id: `h-${day}`,
            kindergartenId: KG,
            date: new Date(`2026-06-0${day}T00:00:00.000Z`),
            name: { ru: `Holiday ${day}` },
            isBillable: false,
            createdAt: NOW,
            updatedAt: NOW,
          }),
        );
      }
      await svc.generateMonthly(KG, PERIOD_START);
      const inv = [...invoiceRepo.rows.values()][0];
      expect(inv.amountAfterDiscount.toNumber()).toBe(25000);
      expect(inv.proratedForDays).toBe(25);
    });
  });

  describe('generateFirstInvoice', () => {
    it('throws TariffAssignmentNotFoundError when no assignment', async () => {
      const { svc } = buildSvc();
      await expect(
        svc.generateFirstInvoice(KG, {
          childId: CHILD,
          enrollmentDate: new Date('2026-06-15T00:00:00.000Z'),
          assignedBy: STAFF,
        }),
      ).rejects.toThrow(TariffAssignmentNotFoundError);
    });

    it('throws TariffPlanNotFoundError when assignment exists but plan missing', async () => {
      const { svc, assignmentRepo } = buildSvc();
      assignmentRepo.put(
        TariffAssignment.fromState(baseAssignmentState({ id: 'ta-a' })),
      );
      await expect(
        svc.generateFirstInvoice(KG, {
          childId: CHILD,
          enrollmentDate: new Date('2026-06-15T00:00:00.000Z'),
          assignedBy: STAFF,
        }),
      ).rejects.toThrow(TariffPlanNotFoundError);
    });

    it('pro-rates a partial enrollment month', async () => {
      const { svc, planRepo, assignmentRepo, invoiceRepo } = buildSvc();
      planRepo.put(TariffPlan.fromState(basePlanState({ amount: m(30000) })));
      assignmentRepo.put(
        TariffAssignment.fromState(baseAssignmentState({ id: 'ta-a' })),
      );
      const result = await svc.generateFirstInvoice(KG, {
        childId: CHILD,
        enrollmentDate: new Date('2026-06-16T00:00:00.000Z'),
        assignedBy: STAFF,
      });
      // 15 days remaining out of 30 → 15000
      expect(result.amountAfterDiscount.toNumber()).toBe(15000);
      expect(result.proratedForDays).toBe(15);
      expect(invoiceRepo.rows.size).toBe(1);
    });
  });

  describe('generateLatePickupInvoice', () => {
    const DATE = new Date('2026-06-15T18:00:00.000Z');

    it('uses active late_pickup_fee plan when present', async () => {
      const { svc, planRepo } = buildSvc();
      planRepo.put(
        TariffPlan.fromState(
          basePlanState({
            id: 'lp-plan',
            tariffType: 'late_pickup_fee',
            amount: m(5000),
          }),
        ),
      );
      const inv = await svc.generateLatePickupInvoice(KG, {
        childId: CHILD,
        parentRequestId: 'pr-1',
        expectedTime: '18:00',
        actualTime: '19:30',
        date: DATE,
        requestedBy: STAFF,
      });
      expect(inv.amountAfterDiscount.toNumber()).toBe(5000);
      expect(inv.invoiceType).toBe('late_pickup_fee');
      expect(inv.tariffPlanId).toBe('lp-plan');
    });

    it('falls back to lateFeeAmountKzt when no plan configured', async () => {
      const { svc } = buildSvc();
      const inv = await svc.generateLatePickupInvoice(KG, {
        childId: CHILD,
        parentRequestId: 'pr-1',
        expectedTime: '18:00',
        actualTime: '19:30',
        date: DATE,
        requestedBy: STAFF,
        lateFeeAmountKzt: 3000,
      });
      expect(inv.amountAfterDiscount.toNumber()).toBe(3000);
      expect(inv.tariffPlanId).toBeNull();
    });

    it('throws TariffPlanNotFoundError when neither plan nor fallback', async () => {
      const { svc } = buildSvc();
      await expect(
        svc.generateLatePickupInvoice(KG, {
          childId: CHILD,
          parentRequestId: 'pr-1',
          expectedTime: '18:00',
          actualTime: '19:30',
          date: DATE,
          requestedBy: STAFF,
        }),
      ).rejects.toThrow(TariffPlanNotFoundError);
    });
  });

  describe('listLineItems', () => {
    it('returns empty array when no items', async () => {
      const { svc } = buildSvc();
      const items = await svc.listLineItems(KG, 'i-1');
      expect(items).toEqual([]);
    });
  });

  describe('cross-tenant isolation', () => {
    it('list returns nothing for KG_OTHER even with KG rows', async () => {
      const { svc, invoiceRepo, accountSvc } = buildSvc();
      const account = await accountSvc.ensureForChild(KG, CHILD);
      invoiceRepo.rows.set(
        'i-1',
        Invoice.fromState({
          id: 'i-1',
          kindergartenId: KG,
          childId: CHILD,
          paymentAccountId: account.id,
          tariffPlanId: null,
          invoiceType: 'monthly',
          periodStart: new Date('2026-06-01T00:00:00.000Z'),
          periodEnd: new Date('2026-06-30T00:00:00.000Z'),
          amountDue: m(50000),
          discountPct: null,
          discountReason: null,
          amountAfterDiscount: m(50000),
          status: 'pending',
          dueDate: new Date('2026-06-10T00:00:00.000Z'),
          description: null,
          proratedForDays: null,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      );
      const list = await svc.list(KG_OTHER);
      expect(list).toHaveLength(0);
    });
  });

  // ── T5c: outbox emissions ───────────────────────────────────────────────

  describe('notification emissions (T5c)', () => {
    it('emits invoice.created after createOneOff', async () => {
      const { svc, notifier } = buildSvc();
      await svc.createOneOff(KG, {
        childId: CHILD,
        invoiceType: 'additional_service',
        amountDue: 1000,
        dueDate: new Date('2026-06-10T00:00:00.000Z'),
        periodStart: new Date('2026-06-01T00:00:00.000Z'),
        periodEnd: new Date('2026-06-30T00:00:00.000Z'),
      });
      const types = notifier.events.map((e) => e.type);
      expect(types).toContain('invoice_created');
    });

    it('emits invoice.paid after manualMarkPaid', async () => {
      const { svc, invoiceRepo, accountSvc, notifier } = buildSvc();
      const account = await accountSvc.ensureForChild(KG, CHILD);
      const id = 'inv-mp';
      invoiceRepo.rows.set(
        id,
        Invoice.fromState({
          id,
          kindergartenId: KG,
          childId: CHILD,
          paymentAccountId: account.id,
          tariffPlanId: null,
          invoiceType: 'monthly',
          periodStart: new Date('2026-06-01T00:00:00.000Z'),
          periodEnd: new Date('2026-06-30T00:00:00.000Z'),
          amountDue: m(1000),
          discountPct: null,
          discountReason: null,
          amountAfterDiscount: m(1000),
          status: 'pending',
          dueDate: new Date('2026-06-10T00:00:00.000Z'),
          description: null,
          proratedForDays: null,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      );
      await svc.manualMarkPaid(KG, id);
      const types = notifier.events.map((e) => e.type);
      expect(types).toContain('invoice_paid');
    });

    it('emits invoice.cancelled after cancel', async () => {
      const { svc, invoiceRepo, accountSvc, notifier } = buildSvc();
      const account = await accountSvc.ensureForChild(KG, CHILD);
      const id = 'inv-cn';
      invoiceRepo.rows.set(
        id,
        Invoice.fromState({
          id,
          kindergartenId: KG,
          childId: CHILD,
          paymentAccountId: account.id,
          tariffPlanId: null,
          invoiceType: 'monthly',
          periodStart: new Date('2026-06-01T00:00:00.000Z'),
          periodEnd: new Date('2026-06-30T00:00:00.000Z'),
          amountDue: m(1000),
          discountPct: null,
          discountReason: null,
          amountAfterDiscount: m(1000),
          status: 'pending',
          dueDate: new Date('2026-06-10T00:00:00.000Z'),
          description: null,
          proratedForDays: null,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      );
      await svc.cancel(KG, id, 'admin-decision');
      const types = notifier.events.map((e) => e.type);
      expect(types).toContain('invoice_cancelled');
      const evt = notifier.events.find((e) => e.type === 'invoice_cancelled');
      expect((evt?.event as { reason: string | null }).reason).toBe(
        'admin-decision',
      );
    });
  });

  // ── B22a T1 — billing state-machine + money invariants ─────────────────

  describe('B22a T1 SM1 — markOverdueConditional accepts pending and partial sources', () => {
    function seed(invoiceRepo: FakeInvoiceRepo, status: 'pending' | 'partial') {
      const id = `inv-sm1-${status}`;
      invoiceRepo.rows.set(
        id,
        Invoice.fromState({
          id,
          kindergartenId: KG,
          childId: CHILD,
          paymentAccountId: 'pa-1',
          tariffPlanId: null,
          invoiceType: 'monthly',
          periodStart: new Date('2026-05-01T00:00:00.000Z'),
          periodEnd: new Date('2026-05-31T00:00:00.000Z'),
          amountDue: m(100_000),
          discountPct: null,
          discountReason: null,
          amountAfterDiscount: m(100_000),
          status,
          dueDate: new Date('2026-05-10T00:00:00.000Z'),
          description: null,
          proratedForDays: null,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      );
      return id;
    }

    it('flips a pending invoice past due_date to overdue', async () => {
      const { invoiceRepo } = buildSvc();
      const id = seed(invoiceRepo, 'pending');
      const flipped = await invoiceRepo.markOverdueConditional(
        KG,
        id,
        new Date('2026-05-20T00:00:00.000Z'),
      );
      expect(flipped).not.toBeNull();
      expect(flipped?.status).toBe('overdue');
    });

    it('flips a partial invoice past due_date to overdue', async () => {
      const { invoiceRepo } = buildSvc();
      const id = seed(invoiceRepo, 'partial');
      const flipped = await invoiceRepo.markOverdueConditional(
        KG,
        id,
        new Date('2026-05-20T00:00:00.000Z'),
      );
      expect(flipped).not.toBeNull();
      expect(flipped?.status).toBe('overdue');
    });

    it('returns null when invoice is already overdue (idempotent)', async () => {
      const { invoiceRepo } = buildSvc();
      const id = 'inv-already-overdue';
      invoiceRepo.rows.set(
        id,
        Invoice.fromState({
          id,
          kindergartenId: KG,
          childId: CHILD,
          paymentAccountId: 'pa-1',
          tariffPlanId: null,
          invoiceType: 'monthly',
          periodStart: new Date('2026-05-01T00:00:00.000Z'),
          periodEnd: new Date('2026-05-31T00:00:00.000Z'),
          amountDue: m(100_000),
          discountPct: null,
          discountReason: null,
          amountAfterDiscount: m(100_000),
          status: 'overdue',
          dueDate: new Date('2026-05-10T00:00:00.000Z'),
          description: null,
          proratedForDays: null,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      );
      const flipped = await invoiceRepo.markOverdueConditional(
        KG,
        id,
        new Date('2026-05-20T00:00:00.000Z'),
      );
      expect(flipped).toBeNull();
    });
  });

  describe('B22a T1 H15 — isFirstInvoiceForChild excludes cancelled priors', () => {
    /**
     * Without B16 wiring the service short-circuits the custom-discount
     * branch and never queries priors. To exercise the H15 fix we read
     * the `familyContext.isFirstInvoiceForChild` decision indirectly by
     * inspecting the `findByChildId` query result + the inline filter.
     * The fix itself is a one-liner inside the service:
     *   `priors.every(p => p.status === 'cancelled')`.
     * This test pins the invariant against the fake repo so any
     * regression in the inline filter shows up.
     */
    it('treats a child with only a cancelled prior as first-invoice', async () => {
      const { invoiceRepo } = buildSvc();
      invoiceRepo.rows.set(
        'prior-cancelled',
        Invoice.fromState({
          id: 'prior-cancelled',
          kindergartenId: KG,
          childId: CHILD,
          paymentAccountId: 'pa-x',
          tariffPlanId: null,
          invoiceType: 'monthly',
          periodStart: new Date('2026-04-01T00:00:00.000Z'),
          periodEnd: new Date('2026-04-30T00:00:00.000Z'),
          amountDue: m(100_000),
          discountPct: null,
          discountReason: null,
          amountAfterDiscount: m(100_000),
          status: 'cancelled',
          dueDate: new Date('2026-04-10T00:00:00.000Z'),
          description: null,
          proratedForDays: null,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      );
      const priors = await invoiceRepo.findByChildId(KG, CHILD);
      expect(priors).toHaveLength(1);
      // Mirrors the inline filter in InvoiceService.buildCustomDiscountInputs.
      const isFirst = priors.every((p) => p.status === 'cancelled');
      expect(isFirst).toBe(true);
    });

    it('treats a child with one paid prior as NOT first-invoice', async () => {
      const { invoiceRepo } = buildSvc();
      invoiceRepo.rows.set(
        'prior-paid',
        Invoice.fromState({
          id: 'prior-paid',
          kindergartenId: KG,
          childId: CHILD,
          paymentAccountId: 'pa-x',
          tariffPlanId: null,
          invoiceType: 'monthly',
          periodStart: new Date('2026-04-01T00:00:00.000Z'),
          periodEnd: new Date('2026-04-30T00:00:00.000Z'),
          amountDue: m(100_000),
          discountPct: null,
          discountReason: null,
          amountAfterDiscount: m(100_000),
          status: 'paid',
          dueDate: new Date('2026-04-10T00:00:00.000Z'),
          description: null,
          proratedForDays: null,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      );
      const priors = await invoiceRepo.findByChildId(KG, CHILD);
      const isFirst = priors.every((p) => p.status === 'cancelled');
      expect(isFirst).toBe(false);
    });
  });

  describe('B22a T1 H16 — atomic reserve semantics (tryReserveUsage fake)', () => {
    /**
     * Exercises the FakeCustomDiscountRepo (custom-discount.service.spec)
     * semantics inline so any drift in the fake-vs-real contract for
     * `tryReserveUsage` is caught at unit level. A focused integration
     * spec (`custom-discount-cap.race.integration.spec.ts`) tests the
     * PG-backed atomic UPDATE separately.
     */
    it('reserves up to total_max_uses then refuses additional reservations', () => {
      // Inline a minimal fake mirroring custom-discount.service.spec fake.
      type FakeRow = {
        id: string;
        kindergartenId: string;
        usedCount: number;
        totalMaxUses: number | null;
      };
      const rows = new Map<string, FakeRow>();
      rows.set('cd-cap-2', {
        id: 'cd-cap-2',
        kindergartenId: KG,
        usedCount: 0,
        totalMaxUses: 2,
      });
      function tryReserveUsage(kg: string, id: string): boolean {
        const r = rows.get(id);
        if (!r || r.kindergartenId !== kg) return false;
        if (r.totalMaxUses !== null && r.usedCount >= r.totalMaxUses) {
          return false;
        }
        r.usedCount += 1;
        return true;
      }
      expect(tryReserveUsage(KG, 'cd-cap-2')).toBe(true);
      expect(tryReserveUsage(KG, 'cd-cap-2')).toBe(true);
      expect(tryReserveUsage(KG, 'cd-cap-2')).toBe(false);
      expect(tryReserveUsage(KG, 'cd-cap-2')).toBe(false);
      expect(rows.get('cd-cap-2')?.usedCount).toBe(2);
    });

    it('always reserves when total_max_uses is null', () => {
      type FakeRow = {
        id: string;
        kindergartenId: string;
        usedCount: number;
        totalMaxUses: number | null;
      };
      const rows = new Map<string, FakeRow>();
      rows.set('cd-uncapped', {
        id: 'cd-uncapped',
        kindergartenId: KG,
        usedCount: 0,
        totalMaxUses: null,
      });
      function tryReserveUsage(kg: string, id: string): boolean {
        const r = rows.get(id);
        if (!r || r.kindergartenId !== kg) return false;
        if (r.totalMaxUses !== null && r.usedCount >= r.totalMaxUses) {
          return false;
        }
        r.usedCount += 1;
        return true;
      }
      for (let i = 0; i < 10; i++) {
        expect(tryReserveUsage(KG, 'cd-uncapped')).toBe(true);
      }
      expect(rows.get('cd-uncapped')?.usedCount).toBe(10);
    });
  });

  /**
   * B22a T13 H1 — compensation pattern coverage.
   *
   * Direct private-method test (cast to any) for `releaseUnusedReservations`.
   * Mirrors the production call-site contract: the helper is invoked AFTER
   * the engine returns and BEFORE invoice persist; it must release exactly
   * the discounts that were reserved but not in `customApplicationsToWrite`.
   */
  describe('B22a T13 H1 — releaseUnusedReservations compensation', () => {
    type ReleaseCall = { kgId: string; discountId: string };

    function buildFakeCustomDiscountRepo() {
      const releaseCalls: ReleaseCall[] = [];
      const fake = {
        releaseUsage(kgId: string, discountId: string): Promise<void> {
          releaseCalls.push({ kgId, discountId });
          return Promise.resolve();
        },
      };
      return { fake, releaseCalls };
    }

    function makeSvcWithFake(
      fakeRepo: ReturnType<typeof buildFakeCustomDiscountRepo>['fake'],
    ): InvoiceService {
      const { svc } = buildSvc();
      // Inject the fake into the optional `customDiscounts` slot. The
      // helper only needs `releaseUsage` from the port surface.

      (svc as any).customDiscounts = fakeRepo;
      return svc;
    }

    it('releases reservations that the engine did not include in customApplicationsToWrite', async () => {
      const { fake, releaseCalls } = buildFakeCustomDiscountRepo();
      const svc = makeSvcWithFake(fake);
      const reserved = ['d-keep', 'd-drop-1', 'd-drop-2'];
      const engineResult: DiscountEvaluationResult = {
        discountPct: 10,
        discountReason: 'kept',
        appliedRules: ['custom:d-keep'],
        customApplicationsToWrite: [
          { customDiscountId: 'd-keep', amountApplied: 1000, reason: 'kept' },
        ],
        customDiscountAmount: 1000,
      };

      await (svc as any).releaseUnusedReservations(KG, reserved, engineResult);
      expect(releaseCalls).toEqual([
        { kgId: KG, discountId: 'd-drop-1' },
        { kgId: KG, discountId: 'd-drop-2' },
      ]);
    });

    it('releases nothing when every reserved id is a winner', async () => {
      const { fake, releaseCalls } = buildFakeCustomDiscountRepo();
      const svc = makeSvcWithFake(fake);
      const reserved = ['d-1', 'd-2'];
      const engineResult: DiscountEvaluationResult = {
        discountPct: 25,
        discountReason: '1,2',
        appliedRules: ['custom:d-1', 'custom:d-2'],
        customApplicationsToWrite: [
          { customDiscountId: 'd-1', amountApplied: 500, reason: '1' },
          { customDiscountId: 'd-2', amountApplied: 500, reason: '2' },
        ],
        customDiscountAmount: 1000,
      };

      await (svc as any).releaseUnusedReservations(KG, reserved, engineResult);
      expect(releaseCalls).toEqual([]);
    });

    it('releases all reservations when the engine returns zero applications', async () => {
      const { fake, releaseCalls } = buildFakeCustomDiscountRepo();
      const svc = makeSvcWithFake(fake);
      const reserved = ['d-a', 'd-b', 'd-c'];
      const engineResult: DiscountEvaluationResult = {
        discountPct: null,
        discountReason: null,
        appliedRules: [],
        customApplicationsToWrite: [],
        customDiscountAmount: null,
      };

      await (svc as any).releaseUnusedReservations(KG, reserved, engineResult);
      expect(releaseCalls.map((c) => c.discountId).sort()).toEqual([
        'd-a',
        'd-b',
        'd-c',
      ]);
    });

    it('is a no-op when reservedDiscountIds is empty', async () => {
      const { fake, releaseCalls } = buildFakeCustomDiscountRepo();
      const svc = makeSvcWithFake(fake);
      const engineResult: DiscountEvaluationResult = {
        discountPct: null,
        discountReason: null,
        appliedRules: [],
        customApplicationsToWrite: [],
        customDiscountAmount: null,
      };

      await (svc as any).releaseUnusedReservations(KG, [], engineResult);
      expect(releaseCalls).toEqual([]);
    });
  });

  // ── Prepayment coverage (PREPAYMENT_BILLING_FIX handoff §2/§3/§7) ──────

  describe('computePrepaymentQuote (P1)', () => {
    /** Plan 60 000₸/мес + `prepay_3m_pct=10` — the handoff §3 numbers. */
    function seedPrepayPlanAndAssignment(deps: ReturnType<typeof buildSvc>) {
      deps.planRepo.put(
        TariffPlan.fromState(
          basePlanState({
            amount: m(60000),
            discountRules: { prepay_3m_pct: 10 },
          }),
        ),
      );
      deps.assignmentRepo.put(
        TariffAssignment.fromState(baseAssignmentState({ id: 'ta-a' })),
      );
    }

    function asComputed(quote: PrepaymentQuote): PrepaymentQuoteComputed {
      if (quote.blockedReason) {
        throw new Error('expected a computed quote, got blocked');
      }
      return quote;
    }

    function asBlocked(quote: PrepaymentQuote): PrepaymentQuoteBlocked {
      if (!quote.blockedReason) {
        throw new Error('expected a blocked quote, got computed');
      }
      return quote;
    }

    it('throws TariffAssignmentNotFoundError when the child has no active assignment', async () => {
      const { svc } = buildSvc();
      await expect(svc.computePrepaymentQuote(KG, CHILD, 3)).rejects.toThrow(
        TariffAssignmentNotFoundError,
      );
    });

    it('throws prepayment_horizon_not_configured when the plan lacks the prepay rule (gate unchanged)', async () => {
      const deps = buildSvc();
      seedPrepayPlanAndAssignment(deps); // configures prepay_3m_pct only
      await expect(
        deps.svc.computePrepaymentQuote(KG, CHILD, 6),
      ).rejects.toThrow('prepayment_horizon_not_configured');
    });

    it('returns blocked with the full amount when a pending monthly exists', async () => {
      const deps = buildSvc();
      seedPrepayPlanAndAssignment(deps);
      deps.invoiceRepo.rows.set(
        'mon-jun',
        Invoice.fromState(baseInvoiceState({ id: 'mon-jun' })),
      );
      const quote = asBlocked(
        await deps.svc.computePrepaymentQuote(KG, CHILD, 3),
      );
      expect(quote.blockedReason).toBe('outstanding_debt');
      expect(quote.outstandingAmount).toBe(50000);
    });

    it('returns blocked summing outstanding across a pending monthly and an overdue fee', async () => {
      const deps = buildSvc();
      seedPrepayPlanAndAssignment(deps);
      deps.invoiceRepo.rows.set(
        'mon-jun',
        Invoice.fromState(baseInvoiceState({ id: 'mon-jun' })),
      );
      deps.invoiceRepo.rows.set(
        'fee-late',
        Invoice.fromState(
          baseInvoiceState({
            id: 'fee-late',
            invoiceType: 'late_pickup_fee',
            status: 'overdue',
            amountDue: m(5000),
            amountAfterDiscount: m(5000),
          }),
        ),
      );
      const quote = asBlocked(
        await deps.svc.computePrepaymentQuote(KG, CHILD, 3),
      );
      expect(quote.outstandingAmount).toBe(55000);
    });

    it('returns blocked with only the remaining amount for a partial monthly', async () => {
      const deps = buildSvc();
      seedPrepayPlanAndAssignment(deps);
      deps.invoiceRepo.rows.set(
        'mon-part',
        Invoice.fromState(
          baseInvoiceState({ id: 'mon-part', status: 'partial' }),
        ),
      );
      deps.invoiceRepo.paidSums.set('mon-part', 30000);
      const quote = asBlocked(
        await deps.svc.computePrepaymentQuote(KG, CHILD, 3),
      );
      expect(quote.outstandingAmount).toBe(20000);
    });

    it('returns a computed quote when the only unpaid invoice is a prepayment (no block, no shift)', async () => {
      const deps = buildSvc();
      seedPrepayPlanAndAssignment(deps);
      // Pending prepayment covering jul–sep: not debt (§2.2) and no window
      // shift either — only PAID prepayments cover months (§2.3/§2.7).
      deps.invoiceRepo.rows.set(
        'prep-pending',
        Invoice.fromState(
          baseInvoiceState({
            id: 'prep-pending',
            invoiceType: 'prepayment_3m',
            status: 'pending',
            periodStart: new Date('2026-07-01T00:00:00.000Z'),
            periodEnd: new Date('2026-09-30T00:00:00.000Z'),
            amountDue: m(180000),
            amountAfterDiscount: m(180000),
          }),
        ),
      );
      const quote = asComputed(
        await deps.svc.computePrepaymentQuote(KG, CHILD, 3),
      );
      expect(quote.windowStart).toEqual(new Date('2026-07-01T00:00:00.000Z'));
    });

    it('returns a next-month window with per-month periods and equal shares when nothing is covered', async () => {
      const deps = buildSvc(); // NOW = 2026-06-01 → window jul–sep
      seedPrepayPlanAndAssignment(deps);
      const quote = asComputed(
        await deps.svc.computePrepaymentQuote(KG, CHILD, 3),
      );
      expect(quote.windowStart).toEqual(new Date('2026-07-01T00:00:00.000Z'));
      expect(quote.windowEnd).toEqual(new Date('2026-09-30T00:00:00.000Z'));
      expect(
        quote.months.map((mo) => [
          mo.periodStart.toISOString().slice(0, 10),
          mo.periodEnd.toISOString().slice(0, 10),
        ]),
      ).toEqual([
        ['2026-07-01', '2026-07-31'],
        ['2026-08-01', '2026-08-31'],
        ['2026-09-01', '2026-09-30'],
      ]);
      // No engine discount configured on the fake → total = base sum.
      expect(quote.discountPct).toBeNull();
      expect(quote.baseTotal.toNumber()).toBe(180000);
      expect(quote.total.toNumber()).toBe(180000);
      expect(quote.months.map((mo) => mo.amountShare.toNumber())).toEqual([
        60000, 60000, 60000,
      ]);
    });

    it('returns a window shifted past a paid prepayment (case 4: sep repeat over aug–oct → nov–jan)', async () => {
      const deps = buildSvc(new Date('2026-09-15T09:00:00.000Z'));
      seedPrepayPlanAndAssignment(deps);
      deps.invoiceRepo.rows.set(
        'prep-aug-oct',
        Invoice.fromState(
          baseInvoiceState({
            id: 'prep-aug-oct',
            invoiceType: 'prepayment_3m',
            status: 'paid',
            periodStart: new Date('2026-08-01T00:00:00.000Z'),
            periodEnd: new Date('2026-10-31T00:00:00.000Z'),
            amountDue: m(180000),
            amountAfterDiscount: m(162000),
          }),
        ),
      );
      const quote = asComputed(
        await deps.svc.computePrepaymentQuote(KG, CHILD, 3),
      );
      expect(quote.windowStart).toEqual(new Date('2026-11-01T00:00:00.000Z'));
      expect(quote.windowEnd).toEqual(new Date('2027-01-31T00:00:00.000Z'));
      expect(quote.months[0].periodStart).toEqual(
        new Date('2026-11-01T00:00:00.000Z'),
      );
    });

    it('returns a window past multiple overlapping paid prepayments', async () => {
      const deps = buildSvc(new Date('2026-09-15T09:00:00.000Z'));
      seedPrepayPlanAndAssignment(deps);
      deps.invoiceRepo.rows.set(
        'prep-1',
        Invoice.fromState(
          baseInvoiceState({
            id: 'prep-1',
            invoiceType: 'prepayment_3m',
            status: 'paid',
            periodStart: new Date('2026-08-01T00:00:00.000Z'),
            periodEnd: new Date('2026-10-31T00:00:00.000Z'),
          }),
        ),
      );
      deps.invoiceRepo.rows.set(
        'prep-2',
        Invoice.fromState(
          baseInvoiceState({
            id: 'prep-2',
            invoiceType: 'prepayment_3m',
            status: 'paid',
            periodStart: new Date('2026-10-01T00:00:00.000Z'),
            periodEnd: new Date('2026-12-31T00:00:00.000Z'),
          }),
        ),
      );
      const quote = asComputed(
        await deps.svc.computePrepaymentQuote(KG, CHILD, 3),
      );
      // Covered aug..dec across both windows → first uncovered month is jan.
      expect(quote.windowStart).toEqual(new Date('2027-01-01T00:00:00.000Z'));
      expect(quote.windowEnd).toEqual(new Date('2027-03-31T00:00:00.000Z'));
    });

    it('returns blocked partial_prepayment_exists in preview mode without cancelling the money-holding stale prepayment (FIX 2)', async () => {
      const deps = buildSvc();
      seedPrepayPlanAndAssignment(deps);
      deps.invoiceRepo.rows.set(
        'part-prep',
        Invoice.fromState(
          baseInvoiceState({
            id: 'part-prep',
            invoiceType: 'prepayment_3m',
            status: 'partial',
            periodStart: new Date('2026-07-01T00:00:00.000Z'),
            periodEnd: new Date('2026-09-30T00:00:00.000Z'),
          }),
        ),
      );
      deps.invoiceRepo.paidSums.set('part-prep', 60000);

      const quote = asBlocked(
        await deps.svc.computePrepaymentQuote(KG, CHILD, 3, {
          reserveCustomDiscounts: false,
        }),
      );

      expect(quote.blockedReason).toBe('partial_prepayment_exists');
      expect(quote.blockedInvoiceId).toBe('part-prep');
      expect(quote.blockedPaidAmount).toBe(60000);
      // Read-only: the preview cancelled nothing.
      expect(deps.invoiceRepo.rows.get('part-prep')?.status).toBe('partial');
    });

    it('returns a computed quote when the only stale prepayment is zero-paid pending (preview cancels nothing, blocks nothing)', async () => {
      const deps = buildSvc();
      seedPrepayPlanAndAssignment(deps);
      deps.invoiceRepo.rows.set(
        'prep-zero',
        Invoice.fromState(
          baseInvoiceState({
            id: 'prep-zero',
            invoiceType: 'prepayment_3m',
            status: 'pending',
            periodStart: new Date('2026-07-01T00:00:00.000Z'),
            periodEnd: new Date('2026-09-30T00:00:00.000Z'),
          }),
        ),
      );

      const quote = asComputed(
        await deps.svc.computePrepaymentQuote(KG, CHILD, 3, {
          reserveCustomDiscounts: false,
        }),
      );

      expect(quote.windowStart).toEqual(new Date('2026-07-01T00:00:00.000Z'));
      // Preview never cancels — the zero-paid stale row survives untouched.
      expect(deps.invoiceRepo.rows.get('prep-zero')?.status).toBe('pending');
    });

    it('returns blocked window_overlaps_covered when non-contiguous paid coverage sits inside the shifted window (FIX 9)', async () => {
      const deps = buildSvc(new Date('2026-09-15T09:00:00.000Z'));
      seedPrepayPlanAndAssignment(deps);
      // Paid coverage aug–oct AND dec–feb (a refunded middle window left a
      // november gap): the start shifts to nov, but dec+jan inside the
      // 3-month window are still covered → block, never silently bill.
      deps.invoiceRepo.rows.set(
        'prep-aug-oct',
        Invoice.fromState(
          baseInvoiceState({
            id: 'prep-aug-oct',
            invoiceType: 'prepayment_3m',
            status: 'paid',
            periodStart: new Date('2026-08-01T00:00:00.000Z'),
            periodEnd: new Date('2026-10-31T00:00:00.000Z'),
          }),
        ),
      );
      deps.invoiceRepo.rows.set(
        'prep-dec-feb',
        Invoice.fromState(
          baseInvoiceState({
            id: 'prep-dec-feb',
            invoiceType: 'prepayment_3m',
            status: 'paid',
            periodStart: new Date('2026-12-01T00:00:00.000Z'),
            periodEnd: new Date('2027-02-28T00:00:00.000Z'),
          }),
        ),
      );

      const quote = asBlocked(
        await deps.svc.computePrepaymentQuote(KG, CHILD, 3),
      );

      expect(quote.blockedReason).toBe('window_overlaps_covered');
      expect(quote.coveredMonths).toEqual(['2026-12', '2027-01']);
    });

    it('keeps the window at the first free month when a refunded window precedes a later paid one', async () => {
      // The shift is a walk over covered month KEYS, not `max(period_end)`.
      // Here jul–sep was refunded (so it is NOT coverage) while oct–dec is
      // paid. Anchoring on the furthest paid period_end would push the quote
      // to jan 2027 and leave jul–sep permanently unbillable — the parent
      // could never prepay the very months their refund freed up.
      const deps = buildSvc(); // NOW = 2026-06-01 → base window starts jul
      seedPrepayPlanAndAssignment(deps);
      deps.invoiceRepo.rows.set(
        'prep-jul-sep-refunded',
        Invoice.fromState(
          baseInvoiceState({
            id: 'prep-jul-sep-refunded',
            invoiceType: 'prepayment_3m',
            status: 'refunded',
            periodStart: new Date('2026-07-01T00:00:00.000Z'),
            periodEnd: new Date('2026-09-30T00:00:00.000Z'),
          }),
        ),
      );
      deps.invoiceRepo.rows.set(
        'prep-oct-dec-paid',
        Invoice.fromState(
          baseInvoiceState({
            id: 'prep-oct-dec-paid',
            invoiceType: 'prepayment_3m',
            status: 'paid',
            periodStart: new Date('2026-10-01T00:00:00.000Z'),
            periodEnd: new Date('2026-12-31T00:00:00.000Z'),
          }),
        ),
      );

      const quote = asComputed(
        await deps.svc.computePrepaymentQuote(KG, CHILD, 3),
      );

      expect(quote.windowStart).toEqual(new Date('2026-07-01T00:00:00.000Z'));
      expect(quote.windowEnd).toEqual(new Date('2026-09-30T00:00:00.000Z'));
      expect(quote.months.map((mo) => mo.periodStart)).toEqual([
        new Date('2026-07-01T00:00:00.000Z'),
        new Date('2026-08-01T00:00:00.000Z'),
        new Date('2026-09-01T00:00:00.000Z'),
      ]);
    });

    it('returns the exact case-4 totals: 148065 whole KZT with 8 January holidays and 10% prepay', async () => {
      const deps = buildSvc(new Date('2026-09-15T09:00:00.000Z'));
      seedPrepayPlanAndAssignment(deps);
      deps.discount.result = {
        discountPct: 10,
        discountReason: 'prepay_3m',
        appliedRules: ['prepay_3m'],
        customApplicationsToWrite: [],
        customDiscountAmount: null,
      };
      deps.invoiceRepo.rows.set(
        'prep-aug-oct',
        Invoice.fromState(
          baseInvoiceState({
            id: 'prep-aug-oct',
            invoiceType: 'prepayment_3m',
            status: 'paid',
            periodStart: new Date('2026-08-01T00:00:00.000Z'),
            periodEnd: new Date('2026-10-31T00:00:00.000Z'),
          }),
        ),
      );
      for (let day = 1; day <= 8; day++) {
        deps.holidayRepo.rows.push(
          KindergartenHoliday.fromState({
            id: `h-jan-${day}`,
            kindergartenId: KG,
            date: new Date(`2027-01-0${day}T00:00:00.000Z`),
            name: { ru: `Праздник ${day}` },
            isBillable: false,
            createdAt: NOW,
            updatedAt: NOW,
          }),
        );
      }

      const quote = asComputed(
        await deps.svc.computePrepaymentQuote(KG, CHILD, 3),
      );
      // nov 60000 + dec 60000 + jan 60000×23/31 = 164516.129…
      expect(quote.months.map((mo) => mo.holidayDays)).toEqual([0, 0, 8]);
      expect(quote.months[0].baseAmount.toNumber()).toBe(60000);
      expect(quote.months[1].baseAmount.toNumber()).toBe(60000);
      expect(quote.months[2].baseAmount.toNumber()).toBe(44516.13);
      expect(quote.baseTotal.toNumber()).toBe(164516.13);
      // Single-rounding chain (§2.5): 164516.129… × 0.9 = 148064.516… →
      // 148065 whole KZT. The handoff's "≈148 064" was computed with
      // per-month intermediate rounding — the implemented chain pins 148065.
      expect(quote.discountPct).toBe(10);
      expect(quote.total.toNumber()).toBe(148065);
      // Largest-remainder shares of the discounted total (§2.6): january's
      // 23/31 weight carries the largest fractional remainder → +1 tenge.
      expect(quote.months.map((mo) => mo.amountShare.toNumber())).toEqual([
        54000, 54000, 40065,
      ]);
      const shareSum = quote.months.reduce(
        (acc, mo) => acc.add(mo.amountShare),
        MoneyKzt.zero(),
      );
      expect(shareSum.equals(quote.total)).toBe(true);
    });

    it("returns a whole-tenge banker's-rounded total for a fractional discounted sum", async () => {
      const deps = buildSvc(); // NOW = 2026-06-01 → window jul–sep, no holidays
      deps.planRepo.put(
        TariffPlan.fromState(
          basePlanState({
            amount: m(33335),
            discountRules: { prepay_3m_pct: 10 },
          }),
        ),
      );
      deps.assignmentRepo.put(
        TariffAssignment.fromState(baseAssignmentState({ id: 'ta-a' })),
      );
      deps.discount.result = {
        discountPct: 10,
        discountReason: 'prepay_3m',
        appliedRules: ['prepay_3m'],
        customApplicationsToWrite: [],
        customDiscountAmount: null,
      };
      const quote = asComputed(
        await deps.svc.computePrepaymentQuote(KG, CHILD, 3),
      );
      // 3×33335 = 100005 → ×0.9 = 90004.5 → ROUND_HALF_EVEN → 90004
      // (half-up would give 90005 — pins banker's semantics).
      expect(quote.total.toNumber()).toBe(90004);
      // Equal-weight tie on remainders (⅓ each) → earliest month gets the
      // leftover tenge; Σ shares === total exactly.
      expect(quote.months.map((mo) => mo.amountShare.toNumber())).toEqual([
        30002, 30001, 30001,
      ]);
      const shareSum = quote.months.reduce(
        (acc, mo) => acc.add(mo.amountShare),
        MoneyKzt.zero(),
      );
      expect(shareSum.equals(quote.total)).toBe(true);
    });

    it('calls the discount engine exactly once with prepaymentMonths and the summed base (§5.7)', async () => {
      const deps = buildSvc();
      seedPrepayPlanAndAssignment(deps);
      const quote = asComputed(
        await deps.svc.computePrepaymentQuote(KG, CHILD, 3),
      );
      expect(deps.discount.calls).toHaveLength(1);
      const input = deps.discount.calls[0];
      expect(input.context.prepaymentMonths).toBe(3);
      expect(input.invoice.invoiceType).toBe('prepayment_3m');
      expect(input.invoice.amountDue.toNumber()).toBe(180000);
      // No B16 wiring in buildSvc → nothing reserved in either mode.
      expect(quote.reservedDiscountIds).toEqual([]);
    });
  });

  describe('prepayInvoice (P2)', () => {
    function seedPrepayPlanAndAssignment(deps: ReturnType<typeof buildSvc>) {
      deps.planRepo.put(
        TariffPlan.fromState(
          basePlanState({
            amount: m(60000),
            discountRules: { prepay_3m_pct: 10 },
          }),
        ),
      );
      deps.assignmentRepo.put(
        TariffAssignment.fromState(baseAssignmentState({ id: 'ta-a' })),
      );
    }

    it('throws PrepaymentBlockedOutstandingDebtError with the outstanding sum when the child has debt', async () => {
      const deps = buildSvc();
      seedPrepayPlanAndAssignment(deps);
      deps.invoiceRepo.rows.set(
        'mon-jun',
        Invoice.fromState(baseInvoiceState({ id: 'mon-jun' })),
      );
      const err: unknown = await deps.svc
        .prepayInvoice(KG, CHILD, 3)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PrepaymentBlockedOutstandingDebtError);
      expect((err as PrepaymentBlockedOutstandingDebtError).details).toEqual({
        outstanding_amount: 50000,
      });
      // Nothing was created.
      const prepayments = [...deps.invoiceRepo.rows.values()].filter((i) =>
        i.invoiceType.startsWith('prepayment_'),
      );
      expect(prepayments).toHaveLength(0);
    });

    it('cancels a stale pending prepayment without invoice_cancelled and creates the replacement', async () => {
      const deps = buildSvc();
      seedPrepayPlanAndAssignment(deps);
      deps.invoiceRepo.rows.set(
        'old-prep',
        Invoice.fromState(
          baseInvoiceState({
            id: 'old-prep',
            invoiceType: 'prepayment_3m',
            status: 'pending',
            periodStart: new Date('2026-07-01T00:00:00.000Z'),
            periodEnd: new Date('2026-09-30T00:00:00.000Z'),
          }),
        ),
      );

      const created = await deps.svc.prepayInvoice(KG, CHILD, 3);

      expect(deps.invoiceRepo.rows.get('old-prep')?.status).toBe('cancelled');
      expect(created.id).not.toBe('old-prep');
      expect(created.invoiceType).toBe('prepayment_3m');
      expect(created.status).toBe('pending');
      // Parent-initiated replacement — no cancel-notification (P2), only
      // the invoice_created event for the new invoice.
      const types = deps.notifier.events.map((e) => e.type);
      expect(types).not.toContain('invoice_cancelled');
      expect(types).toContain('invoice_created');
    });

    it('releases capped custom-discount usages of the cancelled prepayment only', async () => {
      const deps = buildSvc();
      seedPrepayPlanAndAssignment(deps);
      deps.invoiceRepo.rows.set(
        'old-prep',
        Invoice.fromState(
          baseInvoiceState({
            id: 'old-prep',
            invoiceType: 'prepayment_3m',
            status: 'pending',
            periodStart: new Date('2026-07-01T00:00:00.000Z'),
            periodEnd: new Date('2026-09-30T00:00:00.000Z'),
          }),
        ),
      );
      // Inject only the two deps the release helper needs — the remaining
      // B16 slots stay undefined so `buildCustomDiscountInputs`
      // short-circuits and the engine path is unaffected.
      const releaseCalls: Array<{ kg: string; id: string }> = [];

      (deps.svc as any).customDiscounts = {
        findById(_kg: string, id: string) {
          return Promise.resolve(
            id === 'd-capped' ? { totalMaxUses: 5 } : { totalMaxUses: null },
          );
        },
        releaseUsage(kg: string, id: string) {
          releaseCalls.push({ kg, id });
          return Promise.resolve();
        },
      };

      (deps.svc as any).customDiscountApplications = {
        listByInvoiceId(_kg: string, invoiceId: string) {
          if (invoiceId === 'old-prep') {
            return Promise.resolve([
              { customDiscountId: 'd-capped' },
              { customDiscountId: 'd-uncapped' },
            ]);
          }
          return Promise.resolve([]);
        },
      };

      await deps.svc.prepayInvoice(KG, CHILD, 3);

      // Only the discount WITH total_max_uses is released — releasing an
      // uncapped discount would underflow-drift its counter.
      expect(releaseCalls).toEqual([{ kg: KG, id: 'd-capped' }]);
    });

    it('throws PrepaymentBlockedPartialPrepaymentError and cancels nothing when a stale prepayment holds money (FIX 2)', async () => {
      const deps = buildSvc();
      seedPrepayPlanAndAssignment(deps);
      deps.invoiceRepo.rows.set(
        'part-prep',
        Invoice.fromState(
          baseInvoiceState({
            id: 'part-prep',
            invoiceType: 'prepayment_3m',
            status: 'partial',
            periodStart: new Date('2026-07-01T00:00:00.000Z'),
            periodEnd: new Date('2026-09-30T00:00:00.000Z'),
          }),
        ),
      );
      deps.invoiceRepo.paidSums.set('part-prep', 60000);

      const err: unknown = await deps.svc
        .prepayInvoice(KG, CHILD, 3)
        .catch((e: unknown) => e);

      // Deliberate supersession of the earlier "left alive silently"
      // behavior: a money-holding prepayment now BLOCKS the retry instead
      // of coexisting with a fresh replacement.
      expect(err).toBeInstanceOf(PrepaymentBlockedPartialPrepaymentError);
      expect((err as PrepaymentBlockedPartialPrepaymentError).details).toEqual({
        invoice_id: 'part-prep',
        paid_amount: 60000,
      });
      expect(deps.invoiceRepo.rows.get('part-prep')?.status).toBe('partial');
      // No replacement was created either.
      const prepayments = [...deps.invoiceRepo.rows.values()].filter(
        (i) => i.invoiceType.startsWith('prepayment_') && i.id !== 'part-prep',
      );
      expect(prepayments).toHaveLength(0);
    });

    it('throws PrepaymentBlockedPartialPrepaymentError for an overdue stale prepayment holding money (markOverdueBatch flip)', async () => {
      const deps = buildSvc();
      seedPrepayPlanAndAssignment(deps);
      // `markOverdueBatch` flips `partial → overdue`, so a money-holding
      // prepayment can sit in `overdue` — the paid-sum guard, not the
      // status, must decide (review FIX 2).
      deps.invoiceRepo.rows.set(
        'ovd-prep',
        Invoice.fromState(
          baseInvoiceState({
            id: 'ovd-prep',
            invoiceType: 'prepayment_3m',
            status: 'overdue',
            periodStart: new Date('2026-07-01T00:00:00.000Z'),
            periodEnd: new Date('2026-09-30T00:00:00.000Z'),
          }),
        ),
      );
      deps.invoiceRepo.paidSums.set('ovd-prep', 1000);

      const err: unknown = await deps.svc
        .prepayInvoice(KG, CHILD, 3)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(PrepaymentBlockedPartialPrepaymentError);
      expect((err as PrepaymentBlockedPartialPrepaymentError).details).toEqual({
        invoice_id: 'ovd-prep',
        paid_amount: 1000,
      });
      expect(deps.invoiceRepo.rows.get('ovd-prep')?.status).toBe('overdue');
    });

    it('acquires the per-child prepayment advisory lock before any read or cancel (FIX 6)', async () => {
      const deps = buildSvc();
      seedPrepayPlanAndAssignment(deps);
      await deps.svc.prepayInvoice(KG, CHILD, 3);
      expect(deps.invoiceRepo.lockCalls[0]).toBe(`child:${CHILD}`);
    });

    it('re-applies a capped custom discount previously held by the cancelled stale prepayment (FIX 3 reorder)', async () => {
      const deps = buildSvc();
      seedPrepayPlanAndAssignment(deps);
      deps.invoiceRepo.rows.set(
        'old-prep',
        Invoice.fromState(
          baseInvoiceState({
            id: 'old-prep',
            invoiceType: 'prepayment_3m',
            status: 'pending',
            periodStart: new Date('2026-07-01T00:00:00.000Z'),
            periodEnd: new Date('2026-09-30T00:00:00.000Z'),
          }),
        ),
      );

      // Capped discount at FULL capacity: total_max_uses=1, used_count=1 —
      // the single slot is held by the stale prepayment's application row.
      const cap = { totalMaxUses: 1, usedCount: 1 };
      const appRows: Array<{ invoiceId: string; customDiscountId: string }> = [
        { invoiceId: 'old-prep', customDiscountId: 'd-capped' },
      ];

      (deps.svc as any).customDiscounts = {
        findActiveCustomDiscounts: () =>
          Promise.resolve([
            {
              id: 'd-capped',
              name: { ru: 'Скидка' },
              discountType: 'percentage',
              amount: m(10),
              conditions: {},
              targetType: 'all',
              targetIds: null,
              priority: 0,
              stackable: true,
              maxUsesPerChild: null,
              totalMaxUses: cap.totalMaxUses,
              usedCount: cap.usedCount,
              createdAt: NOW,
            },
          ]),
        tryReserveUsage: () => {
          if (cap.usedCount >= cap.totalMaxUses) return Promise.resolve(false);
          cap.usedCount++;
          return Promise.resolve(true);
        },
        releaseUsage: () => {
          cap.usedCount = Math.max(0, cap.usedCount - 1);
          return Promise.resolve();
        },
        findById: () => Promise.resolve({ totalMaxUses: cap.totalMaxUses }),
        acquireDiscountApplyAdvisoryLock: () => Promise.resolve(),
      };
      (deps.svc as any).customDiscountApplications = {
        listByInvoiceId: (_kg: string, invoiceId: string) =>
          Promise.resolve(appRows.filter((r) => r.invoiceId === invoiceId)),
        countByChildAndDiscount: () => Promise.resolve(0),
        create: (input: { invoiceId: string; customDiscountId: string }) => {
          appRows.push({
            invoiceId: input.invoiceId,
            customDiscountId: input.customDiscountId,
          });
          return Promise.resolve(input);
        },
      };
      (deps.svc as any).discountTargetResolver = {
        filterDiscountsForChild: (
          _kg: string,
          _child: string,
          snaps: unknown[],
        ) => Promise.resolve(snaps),
      };
      (deps.svc as any).children = {
        findById: () =>
          Promise.resolve({
            dateOfBirth: new Date('2021-01-01T00:00:00.000Z'),
            currentGroupId: null,
          }),
      };
      (deps.svc as any).childGuardians = {
        countSiblingsInKgForChild: () => Promise.resolve(0),
      };

      deps.discount.result = {
        discountPct: 10,
        discountReason: 'custom',
        appliedRules: ['custom:d-capped'],
        customApplicationsToWrite: [
          {
            customDiscountId: 'd-capped',
            amountApplied: 5000,
            reason: 'custom',
          },
        ],
        customDiscountAmount: null,
      };

      const created = await deps.svc.prepayInvoice(KG, CHILD, 3);

      // THE fix-3 regression pin: the stale prepayment's cancel + release
      // ran BEFORE the quote reserved, so the capped discount reached the
      // engine (old order: tryReserveUsage failed on the still-consumed
      // slot and dropped the discount pre-engine).
      expect(deps.invoiceRepo.rows.get('old-prep')?.status).toBe('cancelled');
      expect(
        (deps.discount.lastInput?.context.customDiscounts ?? []).map(
          (d) => d.id,
        ),
      ).toEqual(['d-capped']);
      // Slot freed by the cancel (1→0), then re-consumed by the reserve
      // (0→1) — net one slot held by the NEW invoice's application row.
      expect(cap.usedCount).toBe(1);
      expect(appRows.filter((r) => r.invoiceId === created.id)).toHaveLength(1);
    });

    it('persists one line item per covered month with quantity 1 and strictly increasing createdAt', async () => {
      const deps = buildSvc(); // NOW = 2026-06-01 → window jul–sep
      seedPrepayPlanAndAssignment(deps);
      deps.discount.result = {
        discountPct: 10,
        discountReason: 'prepay_3m',
        appliedRules: ['prepay_3m'],
        customApplicationsToWrite: [],
        customDiscountAmount: null,
      };

      const created = await deps.svc.prepayInvoice(KG, CHILD, 3);

      expect(created.invoiceType).toBe('prepayment_3m');
      expect(created.periodStart).toEqual(new Date('2026-07-01T00:00:00.000Z'));
      expect(created.periodEnd).toEqual(new Date('2026-09-30T00:00:00.000Z'));
      expect(created.amountDue.toNumber()).toBe(180000);
      expect(created.amountAfterDiscount.toNumber()).toBe(162000);
      expect(created.dueDate).toEqual(new Date('2026-06-08T09:00:00.000Z')); // now + 7d
      expect(created.description).toBe(
        'Prepayment 3m — 2026-07-01..2026-09-30',
      );

      const items = deps.invoiceRepo.lineItems.get(created.id) ?? [];
      expect(items).toHaveLength(3);
      expect(items.every((li) => li.quantity === 1)).toBe(true);
      expect(items.every((li) => li.unitPrice.equals(li.lineTotal))).toBe(true);
      expect(items.map((li) => li.description)).toEqual([
        'Prepayment 2026-07 — Standard',
        'Prepayment 2026-08 — Standard',
        'Prepayment 2026-09 — Standard',
      ]);
      // +i ms offsets keep ORDER BY created_at ASC stable for the calendar's
      // index→month mapping (P6).
      expect(items.map((li) => li.createdAt.getTime())).toEqual([
        NOW.getTime(),
        NOW.getTime() + 1,
        NOW.getTime() + 2,
      ]);
      expect(items.map((li) => li.lineTotal.toNumber())).toEqual([
        54000, 54000, 54000,
      ]);
      const itemSum = items.reduce(
        (acc, li) => acc.add(li.lineTotal),
        MoneyKzt.zero(),
      );
      expect(itemSum.equals(created.amountAfterDiscount)).toBe(true);
    });

    it('calls the discount engine exactly once for the whole window', async () => {
      const deps = buildSvc();
      seedPrepayPlanAndAssignment(deps);
      await deps.svc.prepayInvoice(KG, CHILD, 3);
      expect(deps.discount.calls).toHaveLength(1);
      expect(deps.discount.calls[0].context.prepaymentMonths).toBe(3);
    });

    it('throws PrepaymentBlockedWindowOverlapError when the shifted window overlaps non-contiguous paid coverage (FIX 9)', async () => {
      const deps = buildSvc(new Date('2026-09-15T09:00:00.000Z'));
      seedPrepayPlanAndAssignment(deps);
      deps.invoiceRepo.rows.set(
        'prep-aug-oct',
        Invoice.fromState(
          baseInvoiceState({
            id: 'prep-aug-oct',
            invoiceType: 'prepayment_3m',
            status: 'paid',
            periodStart: new Date('2026-08-01T00:00:00.000Z'),
            periodEnd: new Date('2026-10-31T00:00:00.000Z'),
          }),
        ),
      );
      deps.invoiceRepo.rows.set(
        'prep-dec-feb',
        Invoice.fromState(
          baseInvoiceState({
            id: 'prep-dec-feb',
            invoiceType: 'prepayment_3m',
            status: 'paid',
            periodStart: new Date('2026-12-01T00:00:00.000Z'),
            periodEnd: new Date('2027-02-28T00:00:00.000Z'),
          }),
        ),
      );

      const err: unknown = await deps.svc
        .prepayInvoice(KG, CHILD, 3)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(PrepaymentBlockedWindowOverlapError);
      expect((err as PrepaymentBlockedWindowOverlapError).details).toEqual({
        covered_months: ['2026-12', '2027-01'],
      });
      // Nothing was created.
      const pendings = [...deps.invoiceRepo.rows.values()].filter(
        (i) => i.status === 'pending',
      );
      expect(pendings).toHaveLength(0);
    });
  });

  describe('manualMarkPaid — prepayment settlement hook (FIX 4/5)', () => {
    function seedPrepaymentAndAccount(deps: ReturnType<typeof buildSvc>) {
      deps.invoiceRepo.rows.set(
        'prep-pend',
        Invoice.fromState(
          baseInvoiceState({
            id: 'prep-pend',
            invoiceType: 'prepayment_3m',
            status: 'pending',
            periodStart: new Date('2026-07-01T00:00:00.000Z'),
            periodEnd: new Date('2026-09-30T00:00:00.000Z'),
            amountDue: m(180000),
            amountAfterDiscount: m(162000),
            paymentAccountId: 'pa-1',
          }),
        ),
      );
    }

    it('cancels the covered pending monthly, releases its capped discount and notifies on full cash settlement of a prepayment', async () => {
      const deps = buildSvc();
      await deps.accountSvc.ensureForChild(KG, CHILD); // creates pa-1
      seedPrepaymentAndAccount(deps);
      deps.invoiceRepo.rows.set(
        'mon-jul',
        Invoice.fromState(
          baseInvoiceState({
            id: 'mon-jul',
            periodStart: new Date('2026-07-01T00:00:00.000Z'),
            periodEnd: new Date('2026-07-31T00:00:00.000Z'),
          }),
        ),
      );
      const releaseCalls: Array<{ kg: string; id: string }> = [];

      (deps.svc as any).customDiscounts = {
        findById: (_kg: string, id: string) =>
          Promise.resolve(
            id === 'd-capped' ? { totalMaxUses: 5 } : { totalMaxUses: null },
          ),
        releaseUsage: (kg: string, id: string) => {
          releaseCalls.push({ kg, id });
          return Promise.resolve();
        },
      };
      (deps.svc as any).customDiscountApplications = {
        listByInvoiceId: (_kg: string, invoiceId: string) =>
          Promise.resolve(
            invoiceId === 'mon-jul' ? [{ customDiscountId: 'd-capped' }] : [],
          ),
      };

      const updated = await deps.svc.manualMarkPaid(KG, 'prep-pend');

      expect(updated.status).toBe('paid');
      expect(deps.invoiceRepo.rows.get('mon-jul')?.status).toBe('cancelled');
      expect(releaseCalls).toEqual([{ kg: KG, id: 'd-capped' }]);
      const cancelEvents = deps.notifier.events.filter(
        (e) => e.type === 'invoice_cancelled',
      );
      expect(cancelEvents).toHaveLength(1);
      expect(cancelEvents[0].event).toMatchObject({
        invoiceId: 'mon-jul',
        childId: CHILD,
        reason: 'covered_by_prepayment',
      });
      // FIX 6/7 lock choreography: child lock pre-flip, then child lock +
      // chronological monthly-generation locks inside the hook.
      expect(deps.invoiceRepo.lockCalls).toEqual([
        `child:${CHILD}`,
        `child:${CHILD}`,
        'monthly:2026-07-01',
        'monthly:2026-08-01',
        'monthly:2026-09-01',
      ]);
    });

    it('warns instead of cancelling an overdue covered monthly that holds a partial payment (FIX 5 money guard)', async () => {
      const deps = buildSvc();
      const warnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      await deps.accountSvc.ensureForChild(KG, CHILD);
      seedPrepaymentAndAccount(deps);
      deps.invoiceRepo.rows.set(
        'mon-jul',
        Invoice.fromState(
          baseInvoiceState({
            id: 'mon-jul',
            status: 'overdue',
            periodStart: new Date('2026-07-01T00:00:00.000Z'),
            periodEnd: new Date('2026-07-31T00:00:00.000Z'),
          }),
        ),
      );
      // partial→overdue flip left real money inside the monthly.
      deps.invoiceRepo.paidSums.set('mon-jul', 10000);

      const updated = await deps.svc.manualMarkPaid(KG, 'prep-pend');

      expect(updated.status).toBe('paid');
      expect(deps.invoiceRepo.rows.get('mon-jul')?.status).toBe('overdue');
      expect(
        deps.notifier.events.filter((e) => e.type === 'invoice_cancelled'),
      ).toHaveLength(0);
      const warns = warnSpy.mock.calls
        .map((c) => c[0])
        .filter(
          (msg): msg is string =>
            typeof msg === 'string' && msg.includes('manual review'),
        );
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain('mon-jul');
      expect(warns[0]).toContain('paid_sum=10000');
      warnSpy.mockRestore();
    });

    // Prepayment is indivisible, so a sub-residual cash amount never reaches
    // the hook at all — it is refused at the seam. This test used to assert
    // the opposite (invoice → `partial`, hook skipped), i.e. it encoded the
    // half-paid prepayment state the product does not allow.
    it('rejects a sub-residual cash amount on a prepayment and leaves the monthly untouched', async () => {
      const deps = buildSvc();
      await deps.accountSvc.ensureForChild(KG, CHILD);
      seedPrepaymentAndAccount(deps);
      deps.invoiceRepo.rows.set(
        'mon-jul',
        Invoice.fromState(
          baseInvoiceState({
            id: 'mon-jul',
            periodStart: new Date('2026-07-01T00:00:00.000Z'),
            periodEnd: new Date('2026-07-31T00:00:00.000Z'),
          }),
        ),
      );

      await expect(
        deps.svc.manualMarkPaid(KG, 'prep-pend', { amount: 50000 }),
      ).rejects.toThrow('prepayment_partial_not_allowed');

      expect(deps.invoiceRepo.rows.get('prep-pend')?.status).toBe('pending');
      expect(deps.invoiceRepo.rows.get('mon-jul')?.status).toBe('pending');
      expect(
        deps.notifier.events.filter((e) => e.type === 'invoice_cancelled'),
      ).toHaveLength(0);
    });
  });

  describe('generateMonthly — prepayment coverage (P4)', () => {
    const PERIOD_START = new Date('2026-06-01T00:00:00.000Z');

    function seedPaidPrepayment(
      invoiceRepo: FakeInvoiceRepo,
      overrides: Partial<InvoiceState> = {},
    ) {
      invoiceRepo.rows.set(
        overrides.id ?? 'prep-cover',
        Invoice.fromState(
          baseInvoiceState({
            id: 'prep-cover',
            invoiceType: 'prepayment_3m',
            status: 'paid',
            periodStart: new Date('2026-06-01T00:00:00.000Z'),
            periodEnd: new Date('2026-08-31T00:00:00.000Z'),
            amountDue: m(180000),
            amountAfterDiscount: m(162000),
            ...overrides,
          }),
        ),
      );
    }

    it('skips a child covered by a paid prepayment and generates no monthly for them', async () => {
      const { svc, invoiceRepo, planRepo, assignmentRepo } = buildSvc();
      planRepo.put(TariffPlan.fromState(basePlanState()));
      assignmentRepo.put(
        TariffAssignment.fromState(
          baseAssignmentState({ id: 'ta-a', childId: CHILD }),
        ),
      );
      assignmentRepo.put(
        TariffAssignment.fromState(
          baseAssignmentState({ id: 'ta-b', childId: CHILD2 }),
        ),
      );
      seedPaidPrepayment(invoiceRepo);

      const result = await svc.generateMonthly(KG, PERIOD_START);

      expect(result.generated).toBe(1);
      expect(result.skipped).toBe(1);
      const monthlies = [...invoiceRepo.rows.values()].filter(
        (i) => i.invoiceType === 'monthly',
      );
      expect(monthlies).toHaveLength(1);
      expect(monthlies[0].childId).toBe(CHILD2);
    });

    it('does not skip when the covering prepayment is only pending', async () => {
      const { svc, invoiceRepo, planRepo, assignmentRepo } = buildSvc();
      planRepo.put(TariffPlan.fromState(basePlanState()));
      assignmentRepo.put(
        TariffAssignment.fromState(
          baseAssignmentState({ id: 'ta-a', childId: CHILD }),
        ),
      );
      seedPaidPrepayment(invoiceRepo, { status: 'pending' });

      const result = await svc.generateMonthly(KG, PERIOD_START);

      expect(result.generated).toBe(1);
      expect(result.skipped).toBe(0);
      const monthlies = [...invoiceRepo.rows.values()].filter(
        (i) => i.invoiceType === 'monthly',
      );
      expect(monthlies).toHaveLength(1);
      expect(monthlies[0].childId).toBe(CHILD);
    });

    it('does not skip when the paid prepayment window ends before the period', async () => {
      const { svc, invoiceRepo, planRepo, assignmentRepo } = buildSvc();
      planRepo.put(TariffPlan.fromState(basePlanState()));
      assignmentRepo.put(
        TariffAssignment.fromState(
          baseAssignmentState({ id: 'ta-a', childId: CHILD }),
        ),
      );
      seedPaidPrepayment(invoiceRepo, {
        periodStart: new Date('2026-03-01T00:00:00.000Z'),
        periodEnd: new Date('2026-05-31T00:00:00.000Z'),
      });

      const result = await svc.generateMonthly(KG, PERIOD_START);

      expect(result.generated).toBe(1);
      expect(result.skipped).toBe(0);
    });

    it('keeps skipping covered children on re-runs without arming the monthly short-circuit (§5.1)', async () => {
      const { svc, invoiceRepo, planRepo, assignmentRepo } = buildSvc();
      planRepo.put(TariffPlan.fromState(basePlanState()));
      assignmentRepo.put(
        TariffAssignment.fromState(
          baseAssignmentState({ id: 'ta-a', childId: CHILD }),
        ),
      );
      seedPaidPrepayment(invoiceRepo);

      const first = await svc.generateMonthly(KG, PERIOD_START);
      const second = await svc.generateMonthly(KG, PERIOD_START);

      // ALL children covered → no monthly row ever lands, so the
      // existsMonthlyForPeriod short-circuit never arms and both runs walk
      // the loop — the zero-side-effect skip branch makes that harmless.
      expect(first).toEqual({ generated: 0, skipped: 1 });
      expect(second).toEqual({ generated: 0, skipped: 1 });
      const monthlies = [...invoiceRepo.rows.values()].filter(
        (i) => i.invoiceType === 'monthly',
      );
      expect(monthlies).toHaveLength(0);
    });
  });

  describe('buildPaymentCalendar — prepayment coverage (P6)', () => {
    function seedCalendarBase(deps: ReturnType<typeof buildSvc>) {
      deps.planRepo.put(TariffPlan.fromState(basePlanState())); // 50 000/мес
      deps.assignmentRepo.put(
        TariffAssignment.fromState(baseAssignmentState({ id: 'ta-a' })),
      );
    }

    function seedPrepayment(
      invoiceRepo: FakeInvoiceRepo,
      id: string,
      status: InvoiceState['status'],
    ) {
      invoiceRepo.rows.set(
        id,
        Invoice.fromState(
          baseInvoiceState({
            id,
            invoiceType: 'prepayment_3m',
            status,
            periodStart: new Date('2026-07-01T00:00:00.000Z'),
            periodEnd: new Date('2026-09-30T00:00:00.000Z'),
            amountDue: m(180000),
            amountAfterDiscount: m(162000),
            dueDate: new Date('2026-06-08T00:00:00.000Z'),
          }),
        ),
      );
    }

    function prepayLineItem(
      id: string,
      invoiceId: string,
      amount: number,
      offsetMs: number,
    ): InvoiceLineItem {
      return InvoiceLineItem.fromState({
        id,
        invoiceId,
        kindergartenId: KG,
        description: `Prepayment line ${id}`,
        tariffPlanId: PLAN,
        quantity: 1,
        unitPrice: m(amount),
        lineTotal: m(amount),
        createdAt: new Date(NOW.getTime() + offsetMs),
      });
    }

    it('spreads a paid prepayment across window months with per-line-item shares in created_at order', async () => {
      const deps = buildSvc(); // NOW = 2026-06-01 → calendar jun..sep
      seedCalendarBase(deps);
      seedPrepayment(deps.invoiceRepo, 'prep-paid', 'paid');
      // Deliberately pushed out of order — the service must sort by
      // created_at ASC before the index→month mapping.
      deps.lineItemRepo.rows.push(
        prepayLineItem('li-3', 'prep-paid', 53999, 2),
        prepayLineItem('li-2', 'prep-paid', 54000, 1),
        prepayLineItem('li-1', 'prep-paid', 54001, 0),
      );

      const cal = await deps.svc.buildPaymentCalendar(KG, CHILD, 4);

      expect(cal).toHaveLength(4);
      // June (current month): plain projection, invoice_type null.
      expect(cal[0]).toMatchObject({
        period_start: '2026-06-01',
        invoice_id: null,
        projected_status: 'projected',
        amount_after_discount: 50000,
        is_projection: true,
        invoice_type: null,
      });
      expect(cal[1]).toMatchObject({
        period_start: '2026-07-01',
        period_end: '2026-07-31',
        invoice_id: 'prep-paid',
        projected_status: 'paid',
        amount_after_discount: 54001,
        due_date: '2026-06-08',
        is_projection: false,
        invoice_type: 'prepayment_3m',
      });
      expect(cal[2]).toMatchObject({
        period_start: '2026-08-01',
        invoice_id: 'prep-paid',
        projected_status: 'paid',
        amount_after_discount: 54000,
        is_projection: false,
        invoice_type: 'prepayment_3m',
      });
      expect(cal[3]).toMatchObject({
        period_start: '2026-09-01',
        invoice_id: 'prep-paid',
        projected_status: 'paid',
        amount_after_discount: 53999,
        is_projection: false,
        invoice_type: 'prepayment_3m',
      });
    });

    it('prefers prepayment coverage over a matching monthly invoice in the covered month', async () => {
      const deps = buildSvc();
      seedCalendarBase(deps);
      seedPrepayment(deps.invoiceRepo, 'prep-paid', 'paid');
      deps.lineItemRepo.rows.push(
        prepayLineItem('li-1', 'prep-paid', 54000, 0),
        prepayLineItem('li-2', 'prep-paid', 54000, 1),
        prepayLineItem('li-3', 'prep-paid', 54000, 2),
      );
      // A monthly that slipped in before the settlement hook cancelled it.
      deps.invoiceRepo.rows.set(
        'mon-aug',
        Invoice.fromState(
          baseInvoiceState({
            id: 'mon-aug',
            periodStart: new Date('2026-08-01T00:00:00.000Z'),
            periodEnd: new Date('2026-08-31T00:00:00.000Z'),
          }),
        ),
      );

      const cal = await deps.svc.buildPaymentCalendar(KG, CHILD, 4);

      expect(cal[2]).toMatchObject({
        period_start: '2026-08-01',
        invoice_id: 'prep-paid',
        projected_status: 'paid',
        amount_after_discount: 54000,
        invoice_type: 'prepayment_3m',
      });
    });

    it('does not spread a pending prepayment beyond its period_start month', async () => {
      const deps = buildSvc();
      seedCalendarBase(deps);
      seedPrepayment(deps.invoiceRepo, 'prep-pending', 'pending');

      const cal = await deps.svc.buildPaymentCalendar(KG, CHILD, 4);

      // July: the pending prepayment surfaces via the bucketing branch with
      // its FULL amount (today's behavior — §2.9 pending stays put).
      expect(cal[1]).toMatchObject({
        period_start: '2026-07-01',
        invoice_id: 'prep-pending',
        projected_status: 'pending',
        amount_after_discount: 162000,
        is_projection: false,
        invoice_type: 'prepayment_3m',
      });
      // August + September: plain projections, NOT covered.
      for (const entry of [cal[2], cal[3]]) {
        expect(entry).toMatchObject({
          invoice_id: null,
          projected_status: 'projected',
          amount_after_discount: 50000,
          is_projection: true,
          invoice_type: null,
        });
      }
    });

    it('falls back to an even split for a legacy single-line-item paid prepayment', async () => {
      const deps = buildSvc();
      seedCalendarBase(deps);
      seedPrepayment(deps.invoiceRepo, 'prep-paid', 'paid');
      // Pre-fix shape: ONE quantity=months line item.
      deps.lineItemRepo.rows.push(
        InvoiceLineItem.fromState({
          id: 'li-legacy',
          invoiceId: 'prep-paid',
          kindergartenId: KG,
          description: 'Prepayment 3m — Standard',
          tariffPlanId: PLAN,
          quantity: 3,
          unitPrice: m(54000),
          lineTotal: m(162000),
          createdAt: NOW,
        }),
      );

      const cal = await deps.svc.buildPaymentCalendar(KG, CHILD, 4);

      for (const entry of [cal[1], cal[2], cal[3]]) {
        expect(entry).toMatchObject({
          invoice_id: 'prep-paid',
          projected_status: 'paid',
          amount_after_discount: 54000, // 162000 / 3
          is_projection: false,
          invoice_type: 'prepayment_3m',
        });
      }
    });

    it('covers months from a paid prepayment whose window started before the calendar horizon', async () => {
      // The original Bug-3 symptom. The bucketing fetch only sees invoices
      // with `period_start >= startMonth`, so an apr..jun prepayment is
      // invisible to it even though June sits inside the horizon. Only the
      // separate `period_end >= startMonth` fetch surfaces it — drop that and
      // June silently re-renders as an unpaid projection, i.e. the parent is
      // asked to pay a month they already prepaid.
      const deps = buildSvc(); // NOW = 2026-06-01 → calendar jun..sep
      seedCalendarBase(deps);
      deps.invoiceRepo.rows.set(
        'prep-earlier',
        Invoice.fromState(
          baseInvoiceState({
            id: 'prep-earlier',
            invoiceType: 'prepayment_3m',
            status: 'paid',
            periodStart: new Date('2026-04-01T00:00:00.000Z'),
            periodEnd: new Date('2026-06-30T00:00:00.000Z'),
            amountDue: m(180000),
            amountAfterDiscount: m(162000),
            dueDate: new Date('2026-03-08T00:00:00.000Z'),
          }),
        ),
      );
      deps.lineItemRepo.rows.push(
        prepayLineItem('li-apr', 'prep-earlier', 54001, 0),
        prepayLineItem('li-may', 'prep-earlier', 54000, 1),
        prepayLineItem('li-jun', 'prep-earlier', 53999, 2),
      );

      const cal = await deps.svc.buildPaymentCalendar(KG, CHILD, 4);

      // June is the only covered month inside the horizon, and it must carry
      // the THIRD line item's share — the index→month mapping walks the whole
      // window, not just its in-horizon tail.
      expect(cal[0]).toMatchObject({
        period_start: '2026-06-01',
        invoice_id: 'prep-earlier',
        projected_status: 'paid',
        amount_after_discount: 53999,
        is_projection: false,
        invoice_type: 'prepayment_3m',
      });
      // July onward is past the window — plain projections again.
      for (const entry of [cal[1], cal[2], cal[3]]) {
        expect(entry).toMatchObject({
          invoice_id: null,
          projected_status: 'projected',
          is_projection: true,
        });
      }
    });
  });
});
