import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { InvariantViolationError } from '@/shared-kernel/domain/errors';
import {
  Invoice,
  InvoiceState,
  InvoiceStatus,
} from './domain/entities/invoice.entity';
import {
  Payment,
  PaymentProvider,
  PaymentState,
  PaymentStatus,
} from './domain/entities/payment.entity';
import { PaymentAccount } from './domain/entities/payment-account.entity';
import {
  Refund,
  RefundState,
  RefundStatus,
} from './domain/entities/refund.entity';
import {
  InvoiceNotFoundError,
  PaymentNotFoundError,
  PaymentProviderError,
  PaymentStatusInvalidError,
  RefundAlreadyProcessedError,
  RefundNotFoundError,
} from './domain/errors';
import {
  CreatePaymentInput,
  CreatePaymentResult,
  PaymentProviderPort,
  RefundInput,
  RefundResult,
  VerifyWebhookInput,
  VerifyWebhookResult,
} from './infrastructure/payment-provider/payment-provider.port';
import { InvoiceRepository } from './infrastructure/persistence/invoice.repository';
import { PaymentAccountRepository } from './infrastructure/persistence/payment-account.repository';
import { PaymentRepository } from './infrastructure/persistence/payment.repository';
import {
  ListRefundsFilter,
  RefundRepository,
} from './infrastructure/persistence/refund.repository';
import { InvoiceService } from './invoice.service';
import { PaymentAccountService } from './payment-account.service';
import { RefundService } from './refund.service';

const KG = '11111111-1111-1111-1111-111111111111';
const CHILD = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const ACCOUNT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const INVOICE = 'iiiiiiii-iiii-iiii-iiii-iiiiiiiiiiii';
const PAYMENT = 'pppppppp-pppp-pppp-pppp-pppppppppppp';
const PAYER = 'uuuuuuuu-uuuu-uuuu-uuuu-uuuuuuuuuuuu';
const ADMIN = 'aadd1111-aadd-aadd-aadd-aaddaaddaadd';
const NOW = new Date('2026-06-15T09:00:00.000Z');

class FixedClock extends ClockPort {
  constructor(private d: Date) {
    super();
  }
  now(): Date {
    return this.d;
  }
}

// ── Fakes ────────────────────────────────────────────────────────────────

class FakeRefundRepo extends RefundRepository {
  rows = new Map<string, Refund>();

  create(refund: Refund): Promise<Refund> {
    this.rows.set(refund.id, refund);
    return Promise.resolve(refund);
  }
  findById(kg: string, id: string): Promise<Refund | null> {
    const r = this.rows.get(id);
    if (!r || r.kindergartenId !== kg) return Promise.resolve(null);
    return Promise.resolve(r);
  }
  findByPaymentId(kg: string, paymentId: string): Promise<Refund[]> {
    return Promise.resolve(
      [...this.rows.values()].filter(
        (r) => r.kindergartenId === kg && r.paymentId === paymentId,
      ),
    );
  }
  list(kg: string, filter: ListRefundsFilter = {}): Promise<Refund[]> {
    return Promise.resolve(
      [...this.rows.values()].filter(
        (r) =>
          r.kindergartenId === kg &&
          (!filter.status || r.status === filter.status) &&
          (!filter.paymentId || r.paymentId === filter.paymentId),
      ),
    );
  }
  markApprovedConditional(
    kg: string,
    id: string,
    processedBy: string,
    now: Date,
  ): Promise<Refund | null> {
    return Promise.resolve(
      this.transition(kg, id, ['pending'], (s) => ({
        ...s,
        status: 'approved' as RefundStatus,
        processedBy,
        updatedAt: now,
      })),
    );
  }
  markRejectedConditional(
    kg: string,
    id: string,
    reason: string,
    now: Date,
  ): Promise<Refund | null> {
    return Promise.resolve(
      this.transition(kg, id, ['pending'], (s) => ({
        ...s,
        status: 'rejected' as RefundStatus,
        reason,
        updatedAt: now,
      })),
    );
  }
  markProcessedConditional(
    kg: string,
    id: string,
    providerRef: string | null,
    now: Date,
  ): Promise<Refund | null> {
    return Promise.resolve(
      this.transition(kg, id, ['approved'], (s) => ({
        ...s,
        status: 'processed' as RefundStatus,
        providerRef,
        updatedAt: now,
      })),
    );
  }

  private transition(
    kg: string,
    id: string,
    expected: RefundStatus[],
    patch: (s: RefundState) => RefundState,
  ): Refund | null {
    const r = this.rows.get(id);
    if (!r || r.kindergartenId !== kg) return null;
    if (!expected.includes(r.status)) return null;
    const updated = Refund.fromState(patch(r.toState()));
    this.rows.set(id, updated);
    return updated;
  }
}

class FakePaymentRepo extends PaymentRepository {
  rows = new Map<string, Payment>();
  acquireCalls = 0;

  acquirePaymentAdvisoryLock(): Promise<void> {
    this.acquireCalls++;
    return Promise.resolve();
  }

  create(payment: Payment): Promise<Payment> {
    this.rows.set(payment.id, payment);
    return Promise.resolve(payment);
  }

  findById(kg: string, id: string): Promise<Payment | null> {
    const p = this.rows.get(id);
    if (!p || p.kindergartenId !== kg) return Promise.resolve(null);
    return Promise.resolve(p);
  }

  findByIdempotencyKey(): Promise<Payment | null> {
    return Promise.resolve(null);
  }

  findByInvoiceId(kg: string, invoiceId: string): Promise<Payment[]> {
    return Promise.resolve(
      [...this.rows.values()].filter(
        (p) => p.kindergartenId === kg && p.invoiceId === invoiceId,
      ),
    );
  }

  list(kg: string): Promise<Payment[]> {
    return Promise.resolve(
      [...this.rows.values()].filter((p) => p.kindergartenId === kg),
    );
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

  markRefundedConditional(
    kg: string,
    id: string,
    refundId: string,
    now: Date,
  ): Promise<Payment | null> {
    const p = this.rows.get(id);
    if (!p || p.kindergartenId !== kg) return Promise.resolve(null);
    if (p.status !== 'completed') return Promise.resolve(null);
    const updated = Payment.fromState({
      ...p.toState(),
      status: 'refunded' as PaymentStatus,
      refundId,
      updatedAt: now,
    });
    this.rows.set(id, updated);
    return Promise.resolve(updated);
  }
}

class FakeInvoiceRepo extends InvoiceRepository {
  rows = new Map<string, Invoice>();

  create(): Promise<Invoice> {
    return Promise.reject(new Error('not used'));
  }
  findById(_kg: string, id: string): Promise<Invoice | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }
  list(): Promise<Invoice[]> {
    return Promise.resolve([...this.rows.values()]);
  }
  findByChildId(): Promise<Invoice[]> {
    return Promise.resolve([]);
  }
  existsAnyForPeriod(): Promise<boolean> {
    return Promise.resolve(false);
  }
  getPaidSumForInvoice(): Promise<number> {
    return Promise.resolve(0);
  }
  markPaidConditional(
    _kg: string,
    id: string,
    now: Date,
  ): Promise<Invoice | null> {
    return Promise.resolve(this.flip(id, ['pending', 'partial'], 'paid', now));
  }
  markPartialConditional(): Promise<Invoice | null> {
    return Promise.resolve(null);
  }
  markCancelledConditional(): Promise<Invoice | null> {
    return Promise.resolve(null);
  }
  markRefundedConditional(
    _kg: string,
    id: string,
    now: Date,
  ): Promise<Invoice | null> {
    return Promise.resolve(this.flip(id, ['paid', 'partial'], 'refunded', now));
  }
  markOverdueConditional(): Promise<Invoice | null> {
    return Promise.resolve(null);
  }
  acquireMonthlyGenerationAdvisoryLock(): Promise<void> {
    return Promise.resolve();
  }

  private flip(
    id: string,
    expected: InvoiceStatus[],
    next: InvoiceStatus,
    now: Date,
  ): Invoice | null {
    const inv = this.rows.get(id);
    if (!inv) return null;
    if (!expected.includes(inv.status)) return null;
    const updated = Invoice.fromState({
      ...inv.toState(),
      status: next,
      updatedAt: now,
    });
    this.rows.set(id, updated);
    return updated;
  }
}

class FakePaymentAccountRepo extends PaymentAccountRepository {
  rows = new Map<string, PaymentAccount>();

  put(a: PaymentAccount): void {
    this.rows.set(a.id, a);
  }
  findOrCreateForChild(kg: string, childId: string): Promise<PaymentAccount> {
    for (const a of this.rows.values()) {
      if (a.kindergartenId === kg && a.childId === childId)
        return Promise.resolve(a);
    }
    return Promise.reject(new Error('account not seeded'));
  }
  findById(_kg: string, id: string): Promise<PaymentAccount | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }
  findByChildId(): Promise<PaymentAccount | null> {
    return Promise.resolve(null);
  }
  save(a: PaymentAccount): Promise<PaymentAccount> {
    this.rows.set(a.id, a);
    return Promise.resolve(a);
  }
}

class FakePaymentProvider extends PaymentProviderPort {
  refundCalls: RefundInput[] = [];
  refundImpl: (input: RefundInput) => Promise<RefundResult> = (input) => {
    this.refundCalls.push(input);
    return Promise.resolve({
      providerRefundId: `mock_refund_${input.idempotencyKey}`,
      status: 'processed',
    });
  };

  createPayment(_input: CreatePaymentInput): Promise<CreatePaymentResult> {
    return Promise.reject(new Error('not used'));
  }
  verifyWebhook(_input: VerifyWebhookInput): Promise<VerifyWebhookResult> {
    return Promise.reject(new Error('not used'));
  }
  refund(input: RefundInput): Promise<RefundResult> {
    return this.refundImpl(input);
  }
}

// ── Helpers to seed entities ─────────────────────────────────────────────

function makeInvoice(overrides: Partial<InvoiceState> = {}): Invoice {
  const state: InvoiceState = {
    id: INVOICE,
    kindergartenId: KG,
    childId: CHILD,
    paymentAccountId: ACCOUNT,
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
    ...overrides,
  };
  return Invoice.fromState(state);
}

function makePayment(overrides: Partial<PaymentState> = {}): Payment {
  const state: PaymentState = {
    id: PAYMENT,
    kindergartenId: KG,
    invoiceId: INVOICE,
    childId: CHILD,
    payerUserId: PAYER,
    amount: 50000,
    provider: 'mock' as PaymentProvider,
    providerTxnId: 'tx_done',
    idempotencyKey: 'idem-pay-1',
    status: 'completed',
    providerPayload: null,
    paidAt: NOW,
    refundId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
  return Payment.fromState(state);
}

function makeAccount(balance = 50000): PaymentAccount {
  return PaymentAccount.fromState({
    id: ACCOUNT,
    kindergartenId: KG,
    childId: CHILD,
    balance,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function seedRefund(
  repo: FakeRefundRepo,
  overrides: Partial<RefundState> = {},
): Refund {
  const state: RefundState = {
    id: 'rrrrrrrr-rrrr-rrrr-rrrr-rrrrrrrrrrrr',
    kindergartenId: KG,
    paymentId: PAYMENT,
    invoiceId: INVOICE,
    amount: 50000,
    reason: 'parent requested',
    status: 'pending',
    processedBy: null,
    providerRef: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
  const refund = Refund.fromState(state);
  repo.rows.set(refund.id, refund);
  return refund;
}

// ── Wiring ───────────────────────────────────────────────────────────────

interface Harness {
  service: RefundService;
  refundRepo: FakeRefundRepo;
  paymentRepo: FakePaymentRepo;
  invoiceRepo: FakeInvoiceRepo;
  invoiceService: InvoiceService;
  paymentAccountService: PaymentAccountService;
  paymentAccountRepo: FakePaymentAccountRepo;
  provider: FakePaymentProvider;
  clock: FixedClock;
}

function buildHarness(): Harness {
  const clock = new FixedClock(NOW);
  const refundRepo = new FakeRefundRepo();
  const paymentRepo = new FakePaymentRepo();
  const invoiceRepo = new FakeInvoiceRepo();
  const accountRepo = new FakePaymentAccountRepo();
  const accountService = new PaymentAccountService(accountRepo, clock);
  const provider = new FakePaymentProvider();
  // InvoiceService.get is the only InvoiceService method RefundService uses.
  const invoiceService = {
    get: async (kg: string, id: string) => {
      const inv = await invoiceRepo.findById(kg, id);
      if (!inv) throw new InvoiceNotFoundError(id);
      return inv;
    },
  } as unknown as InvoiceService;
  const service = new RefundService(
    refundRepo,
    paymentRepo,
    invoiceRepo,
    invoiceService,
    accountService,
    provider,
    clock,
  );
  return {
    service,
    refundRepo,
    paymentRepo,
    invoiceRepo,
    invoiceService,
    paymentAccountService: accountService,
    paymentAccountRepo: accountRepo,
    provider,
    clock,
  };
}

// ─────────────────────────────────────────────────────────────────────────

describe('RefundService.create', () => {
  it('returns pending refund when payment is completed and amount is valid', async () => {
    const h = buildHarness();
    h.paymentRepo.rows.set(PAYMENT, makePayment());

    const refund = await h.service.create(KG, {
      paymentId: PAYMENT,
      amount: 50000,
      reason: 'parent requested withdrawal',
    });

    expect(refund.status).toBe('pending');
    expect(refund.amount).toBe(50000);
    expect(refund.paymentId).toBe(PAYMENT);
    expect(refund.invoiceId).toBe(INVOICE);
    expect(refund.processedBy).toBeNull();
    expect(refund.providerRef).toBeNull();
    expect(h.refundRepo.rows.size).toBe(1);
  });

  it('throws PaymentNotFoundError when payment missing', async () => {
    const h = buildHarness();
    await expect(
      h.service.create(KG, {
        paymentId: 'no-such',
        amount: 100,
        reason: 'x',
      }),
    ).rejects.toBeInstanceOf(PaymentNotFoundError);
  });

  it('throws PaymentStatusInvalidError when payment is not completed', async () => {
    const h = buildHarness();
    h.paymentRepo.rows.set(PAYMENT, makePayment({ status: 'failed' }));
    await expect(
      h.service.create(KG, {
        paymentId: PAYMENT,
        amount: 100,
        reason: 'x',
      }),
    ).rejects.toBeInstanceOf(PaymentStatusInvalidError);
  });

  it('throws InvariantViolationError when amount > payment.amount', async () => {
    const h = buildHarness();
    h.paymentRepo.rows.set(PAYMENT, makePayment({ amount: 50000 }));
    await expect(
      h.service.create(KG, {
        paymentId: PAYMENT,
        amount: 50001,
        reason: 'x',
      }),
    ).rejects.toBeInstanceOf(InvariantViolationError);
  });

  it('throws InvariantViolationError when amount <= 0', async () => {
    const h = buildHarness();
    h.paymentRepo.rows.set(PAYMENT, makePayment());
    await expect(
      h.service.create(KG, {
        paymentId: PAYMENT,
        amount: 0,
        reason: 'x',
      }),
    ).rejects.toBeInstanceOf(InvariantViolationError);
    await expect(
      h.service.create(KG, {
        paymentId: PAYMENT,
        amount: -10,
        reason: 'x',
      }),
    ).rejects.toBeInstanceOf(InvariantViolationError);
  });
});

describe('RefundService.approve', () => {
  it('returns approved refund when status was pending', async () => {
    const h = buildHarness();
    const seeded = seedRefund(h.refundRepo);
    const out = await h.service.approve(KG, seeded.id, { processedBy: ADMIN });
    expect(out.status).toBe('approved');
    expect(out.processedBy).toBe(ADMIN);
  });

  it('throws RefundNotFoundError when refund missing', async () => {
    const h = buildHarness();
    await expect(
      h.service.approve(KG, 'no-such', { processedBy: ADMIN }),
    ).rejects.toBeInstanceOf(RefundNotFoundError);
  });

  it('throws RefundAlreadyProcessedError when already approved', async () => {
    const h = buildHarness();
    const seeded = seedRefund(h.refundRepo, { status: 'approved' });
    await expect(
      h.service.approve(KG, seeded.id, { processedBy: ADMIN }),
    ).rejects.toBeInstanceOf(RefundAlreadyProcessedError);
  });

  it('throws RefundAlreadyProcessedError when already processed', async () => {
    const h = buildHarness();
    const seeded = seedRefund(h.refundRepo, { status: 'processed' });
    await expect(
      h.service.approve(KG, seeded.id, { processedBy: ADMIN }),
    ).rejects.toBeInstanceOf(RefundAlreadyProcessedError);
  });

  it('throws RefundAlreadyProcessedError when already rejected', async () => {
    const h = buildHarness();
    const seeded = seedRefund(h.refundRepo, { status: 'rejected' });
    await expect(
      h.service.approve(KG, seeded.id, { processedBy: ADMIN }),
    ).rejects.toBeInstanceOf(RefundAlreadyProcessedError);
  });
});

describe('RefundService.reject', () => {
  it('returns rejected refund when status was pending', async () => {
    const h = buildHarness();
    const seeded = seedRefund(h.refundRepo);
    const out = await h.service.reject(KG, seeded.id, {
      reason: 'duplicate refund request',
    });
    expect(out.status).toBe('rejected');
    expect(out.reason).toBe('duplicate refund request');
  });

  it('throws RefundNotFoundError when refund missing', async () => {
    const h = buildHarness();
    await expect(
      h.service.reject(KG, 'no-such', { reason: 'x' }),
    ).rejects.toBeInstanceOf(RefundNotFoundError);
  });

  it('throws RefundAlreadyProcessedError when not pending', async () => {
    const h = buildHarness();
    const seeded = seedRefund(h.refundRepo, { status: 'approved' });
    await expect(
      h.service.reject(KG, seeded.id, { reason: 'x' }),
    ).rejects.toBeInstanceOf(RefundAlreadyProcessedError);
  });
});

describe('RefundService.process', () => {
  it('atomically processes refund: flips refund/payment/invoice statuses and debits payment_account', async () => {
    const h = buildHarness();
    h.paymentRepo.rows.set(PAYMENT, makePayment());
    h.invoiceRepo.rows.set(INVOICE, makeInvoice({ status: 'paid' }));
    h.paymentAccountRepo.put(makeAccount(50000));
    const seeded = seedRefund(h.refundRepo, { status: 'approved' });

    const out = await h.service.process(KG, seeded.id);

    expect(out.status).toBe('processed');
    expect(out.providerRef).toBe(`mock_refund_refund:${seeded.id}`);

    const paymentAfter = await h.paymentRepo.findById(KG, PAYMENT);
    expect(paymentAfter?.status).toBe('refunded');
    expect(paymentAfter?.refundId).toBe(seeded.id);

    const invoiceAfter = await h.invoiceRepo.findById(KG, INVOICE);
    expect(invoiceAfter?.status).toBe('refunded');

    const accountAfter = await h.paymentAccountRepo.findById(KG, ACCOUNT);
    expect(accountAfter?.balance).toBe(0); // 50000 credit - 50000 refund

    // Provider was called with the deterministic idempotency key.
    expect(h.provider.refundCalls).toHaveLength(1);
    expect(h.provider.refundCalls[0].idempotencyKey).toBe(
      `refund:${seeded.id}`,
    );
    expect(h.provider.refundCalls[0].providerPaymentId).toBe('tx_done');
  });

  it('throws PaymentProviderError when provider.refund throws (refund stays approved for retry)', async () => {
    const h = buildHarness();
    h.paymentRepo.rows.set(PAYMENT, makePayment());
    h.invoiceRepo.rows.set(INVOICE, makeInvoice({ status: 'paid' }));
    h.paymentAccountRepo.put(makeAccount(50000));
    const seeded = seedRefund(h.refundRepo, { status: 'approved' });

    h.provider.refundImpl = () =>
      Promise.reject(new Error('halyk_refund_timeout'));

    await expect(h.service.process(KG, seeded.id)).rejects.toBeInstanceOf(
      PaymentProviderError,
    );

    // Refund/payment/invoice/account untouched — operator can retry.
    const refundAfter = await h.refundRepo.findById(KG, seeded.id);
    expect(refundAfter?.status).toBe('approved');
    const paymentAfter = await h.paymentRepo.findById(KG, PAYMENT);
    expect(paymentAfter?.status).toBe('completed');
    const invoiceAfter = await h.invoiceRepo.findById(KG, INVOICE);
    expect(invoiceAfter?.status).toBe('paid');
    const accountAfter = await h.paymentAccountRepo.findById(KG, ACCOUNT);
    expect(accountAfter?.balance).toBe(50000);
  });

  it('throws RefundNotFoundError when refund missing', async () => {
    const h = buildHarness();
    await expect(h.service.process(KG, 'no-such')).rejects.toBeInstanceOf(
      RefundNotFoundError,
    );
  });

  it('throws RefundAlreadyProcessedError when refund is already processed', async () => {
    const h = buildHarness();
    const seeded = seedRefund(h.refundRepo, {
      status: 'processed',
      providerRef: 'pre-existing',
    });
    await expect(h.service.process(KG, seeded.id)).rejects.toBeInstanceOf(
      RefundAlreadyProcessedError,
    );
  });

  it('throws RefundAlreadyProcessedError when refund status is rejected', async () => {
    const h = buildHarness();
    const seeded = seedRefund(h.refundRepo, { status: 'rejected' });
    await expect(h.service.process(KG, seeded.id)).rejects.toBeInstanceOf(
      RefundAlreadyProcessedError,
    );
  });

  it('throws RefundAlreadyProcessedError when refund status is pending (not approved yet)', async () => {
    const h = buildHarness();
    const seeded = seedRefund(h.refundRepo, { status: 'pending' });
    await expect(h.service.process(KG, seeded.id)).rejects.toBeInstanceOf(
      RefundAlreadyProcessedError,
    );
  });

  it('throws RefundAlreadyProcessedError when conditional UPDATE flips 0 rows mid-flight (race lost)', async () => {
    const h = buildHarness();
    h.paymentRepo.rows.set(PAYMENT, makePayment());
    h.invoiceRepo.rows.set(INVOICE, makeInvoice({ status: 'paid' }));
    h.paymentAccountRepo.put(makeAccount(50000));
    const seeded = seedRefund(h.refundRepo, { status: 'approved' });

    // Simulate a concurrent process that already won the race: between
    // the initial findById (sees `approved`) and the markProcessedConditional
    // call, another process flipped the row to `processed`. The conditional
    // UPDATE then matches 0 rows.
    jest
      .spyOn(h.refundRepo, 'markProcessedConditional')
      .mockImplementationOnce(() => Promise.resolve(null));

    await expect(h.service.process(KG, seeded.id)).rejects.toBeInstanceOf(
      RefundAlreadyProcessedError,
    );
  });

  it('throws PaymentNotFoundError when payment missing during process', async () => {
    const h = buildHarness();
    h.invoiceRepo.rows.set(INVOICE, makeInvoice({ status: 'paid' }));
    const seeded = seedRefund(h.refundRepo, { status: 'approved' });
    // Payment row not seeded.

    await expect(h.service.process(KG, seeded.id)).rejects.toBeInstanceOf(
      PaymentNotFoundError,
    );
  });

  it('throws PaymentStatusInvalidError when payment is no longer completed (defensive guard)', async () => {
    const h = buildHarness();
    h.paymentRepo.rows.set(PAYMENT, makePayment({ status: 'refunded' }));
    h.invoiceRepo.rows.set(INVOICE, makeInvoice({ status: 'refunded' }));
    const seeded = seedRefund(h.refundRepo, { status: 'approved' });

    await expect(h.service.process(KG, seeded.id)).rejects.toBeInstanceOf(
      PaymentStatusInvalidError,
    );
  });
});

describe('RefundService.getById / list', () => {
  it('getById returns the refund', async () => {
    const h = buildHarness();
    const seeded = seedRefund(h.refundRepo);
    const out = await h.service.getById(KG, seeded.id);
    expect(out.id).toBe(seeded.id);
  });

  it('getById throws RefundNotFoundError when missing', async () => {
    const h = buildHarness();
    await expect(h.service.getById(KG, 'absent')).rejects.toBeInstanceOf(
      RefundNotFoundError,
    );
  });

  it('list returns kg-scoped rows applying status filter', async () => {
    const h = buildHarness();
    seedRefund(h.refundRepo, { id: 'r1', status: 'pending' });
    seedRefund(h.refundRepo, { id: 'r2', status: 'approved' });
    seedRefund(h.refundRepo, { id: 'r3', status: 'processed' });

    const all = await h.service.list(KG, {});
    expect(all).toHaveLength(3);
    const approved = await h.service.list(KG, { status: 'approved' });
    expect(approved).toHaveLength(1);
    expect(approved[0].id).toBe('r2');
  });
});
