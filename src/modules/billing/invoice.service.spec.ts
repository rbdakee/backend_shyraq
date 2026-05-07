import { InMemoryNotificationAdapter } from '@/common/notifications/in-memory-notification.adapter';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
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
import { TariffAssignmentNotFoundError } from './domain/errors/tariff-assignment-not-found.error';
import { TariffPlanNotFoundError } from './domain/errors/tariff-plan-not-found.error';
import {
  DiscountEnginePort,
  DiscountEvaluationInput,
  DiscountEvaluationResult,
} from './infrastructure/discount-engine/discount-engine.port';
import { HolidayService } from './holiday.service';
import { InvoiceService } from './invoice.service';
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
    return Promise.resolve(
      this.transitionConditional(
        kindergartenId,
        id,
        ['pending'],
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

  acquireMonthlyGenerationAdvisoryLock(): Promise<void> {
    return Promise.resolve();
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
      customAmount: input.customAmount,
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
      balance: 0,
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
  evaluate(input: DiscountEvaluationInput): Promise<DiscountEvaluationResult> {
    this.lastInput = input;
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
    amount: 50000,
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

function buildSvc() {
  const invoiceRepo = new FakeInvoiceRepo();
  const lineItemRepo = new FakeInvoiceLineItemRepo();
  const planRepo = new FakeTariffPlanRepo();
  const assignmentRepo = new FakeTariffAssignmentRepo();
  const accountRepo = new FakePaymentAccountRepo();
  const paymentRepo = new FakePaymentRepo();
  const holidayRepo = new FakeHolidayRepo();
  const clock = new FakeClock(NOW);
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
          amountDue: 50000,
          discountPct: null,
          discountReason: null,
          amountAfterDiscount: 50000,
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
      expect(inv.amountDue).toBe(10000);
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
      expect(inv.amountAfterDiscount).toBe(45000);
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
          amountDue: 50000,
          discountPct: null,
          discountReason: null,
          amountAfterDiscount: 50000,
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
      expect(acc?.balance).toBe(50000);
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
          amountDue: 50000,
          discountPct: null,
          discountReason: null,
          amountAfterDiscount: 50000,
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
      expect(p.amount).toBe(50000);
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
        amountDue: 50000,
        discountPct: null,
        discountReason: null,
        amountAfterDiscount: 50000,
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
          amountDue: 50000,
          discountPct: null,
          discountReason: null,
          amountAfterDiscount: 50000,
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
          amountDue: 50000,
          discountPct: null,
          discountReason: null,
          amountAfterDiscount: 50000,
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
          amountDue: 50000,
          discountPct: null,
          discountReason: null,
          amountAfterDiscount: 50000,
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
          amountDue: 150_000,
          discountPct: 5,
          discountReason: 'prepay_3m',
          amountAfterDiscount: 142_500,
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
      expect(inv.amountAfterDiscount).toBe(45000);
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
      planRepo.put(TariffPlan.fromState(basePlanState({ amount: 30000 })));
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
      expect(inv.amountAfterDiscount).toBe(25000);
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
      planRepo.put(TariffPlan.fromState(basePlanState({ amount: 30000 })));
      assignmentRepo.put(
        TariffAssignment.fromState(baseAssignmentState({ id: 'ta-a' })),
      );
      const result = await svc.generateFirstInvoice(KG, {
        childId: CHILD,
        enrollmentDate: new Date('2026-06-16T00:00:00.000Z'),
        assignedBy: STAFF,
      });
      // 15 days remaining out of 30 → 15000
      expect(result.amountAfterDiscount).toBe(15000);
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
            amount: 5000,
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
      expect(inv.amountAfterDiscount).toBe(5000);
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
      expect(inv.amountAfterDiscount).toBe(3000);
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
          amountDue: 50000,
          discountPct: null,
          discountReason: null,
          amountAfterDiscount: 50000,
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
          amountDue: 1000,
          discountPct: null,
          discountReason: null,
          amountAfterDiscount: 1000,
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
          amountDue: 1000,
          discountPct: null,
          discountReason: null,
          amountAfterDiscount: 1000,
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
});
