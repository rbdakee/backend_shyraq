import { DataSource, EntityManager } from 'typeorm';
import { InMemoryNotificationAdapter } from '@/common/notifications/in-memory-notification.adapter';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
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
  InvoiceAlreadyPaidError,
  InvoiceNotFoundError,
  InvoiceStatusInvalidError,
  PaymentIdempotencyConflictError,
  PaymentNotFoundError,
  PaymentProviderError,
  PaymentStatusInvalidError,
  WebhookSignatureInvalidError,
} from './domain/errors';
import {
  EmitReceiptInput,
  EmitReceiptResult,
  FiscalReceiptPort,
} from './infrastructure/fiscal-receipt/fiscal-receipt.port';
import {
  CreatePaymentInput,
  CreatePaymentResult,
  PaymentProviderPort,
  RefundInput,
  RefundResult,
  VerifyWebhookInput,
  VerifyWebhookResult,
} from './infrastructure/payment-provider/payment-provider.port';
import {
  InvoiceRepository,
  ListInvoicesFilter,
} from './infrastructure/persistence/invoice.repository';
import {
  ListPaymentsFilter,
  PaymentRepository,
} from './infrastructure/persistence/payment.repository';
import { InvoiceService } from './invoice.service';
import { PaymentService } from './payment.service';
import { PaymentAccountService } from './payment-account.service';
import { PaymentAccountRepository } from './infrastructure/persistence/payment-account.repository';

const KG = '11111111-1111-1111-1111-111111111111';
const KG_OTHER = '22222222-2222-2222-2222-222222222222';
const CHILD = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const ACCOUNT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const INVOICE = 'iiiiiiii-iiii-iiii-iiii-iiiiiiiiiiii';
const PAYER = 'uuuuuuuu-uuuu-uuuu-uuuu-uuuuuuuuuuuu';
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

class FakePaymentRepo extends PaymentRepository {
  rows = new Map<string, Payment>();
  acquireCalls = 0;

  acquirePaymentAdvisoryLock(): Promise<void> {
    this.acquireCalls++;
    return Promise.resolve();
  }

  create(payment: Payment): Promise<Payment> {
    const s = payment.toState();
    for (const existing of this.rows.values()) {
      if (
        existing.idempotencyKey === s.idempotencyKey &&
        existing.kindergartenId === s.kindergartenId
      ) {
        return Promise.reject(
          new PaymentIdempotencyConflictError(s.idempotencyKey),
        );
      }
    }
    this.rows.set(s.id, payment);
    return Promise.resolve(payment);
  }

  findById(kindergartenId: string, id: string): Promise<Payment | null> {
    const p = this.rows.get(id);
    if (!p || p.kindergartenId !== kindergartenId) return Promise.resolve(null);
    return Promise.resolve(p);
  }

  findByIdempotencyKey(
    kindergartenId: string,
    idempotencyKey: string,
  ): Promise<Payment | null> {
    for (const p of this.rows.values()) {
      if (
        p.kindergartenId === kindergartenId &&
        p.idempotencyKey === idempotencyKey
      ) {
        return Promise.resolve(p);
      }
    }
    return Promise.resolve(null);
  }

  findByInvoiceId(
    kindergartenId: string,
    invoiceId: string,
  ): Promise<Payment[]> {
    return Promise.resolve(
      [...this.rows.values()].filter(
        (p) => p.kindergartenId === kindergartenId && p.invoiceId === invoiceId,
      ),
    );
  }

  list(
    kindergartenId: string,
    filter: ListPaymentsFilter = {},
  ): Promise<Payment[]> {
    return Promise.resolve(
      [...this.rows.values()].filter(
        (p) =>
          p.kindergartenId === kindergartenId &&
          (!filter.status || p.status === filter.status) &&
          (!filter.provider || p.provider === filter.provider) &&
          (!filter.childId || p.childId === filter.childId),
      ),
    );
  }

  findByProviderTxnIdCrossTenant(
    provider: PaymentProvider,
    providerTxnId: string,
  ): Promise<Payment | null> {
    for (const p of this.rows.values()) {
      if (p.provider === provider && p.providerTxnId === providerTxnId) {
        return Promise.resolve(p);
      }
    }
    return Promise.resolve(null);
  }

  markCompletedConditional(
    kindergartenId: string,
    id: string,
    providerTxnId: string,
    paidAt: Date,
    providerPayload: Record<string, unknown> | null,
    now: Date,
  ): Promise<Payment | null> {
    return Promise.resolve(
      this.transition(kindergartenId, id, ['initiated', 'processing'], (s) => ({
        ...s,
        status: 'completed' as PaymentStatus,
        providerTxnId,
        paidAt,
        providerPayload,
        updatedAt: now,
      })),
    );
  }

  markFailedConditional(
    kindergartenId: string,
    id: string,
    failureReason: string,
    providerPayload: Record<string, unknown> | null,
    now: Date,
  ): Promise<Payment | null> {
    return Promise.resolve(
      this.transition(kindergartenId, id, ['initiated', 'processing'], (s) => ({
        ...s,
        status: 'failed' as PaymentStatus,
        providerPayload: {
          ...(providerPayload ?? {}),
          failure_reason: failureReason,
        },
        updatedAt: now,
      })),
    );
  }

  markProcessingConditional(
    kindergartenId: string,
    id: string,
    now: Date,
  ): Promise<Payment | null> {
    return Promise.resolve(
      this.transition(kindergartenId, id, ['initiated'], (s) => ({
        ...s,
        status: 'processing' as PaymentStatus,
        updatedAt: now,
      })),
    );
  }

  markRefundedConditional(
    kindergartenId: string,
    id: string,
    refundId: string,
    now: Date,
  ): Promise<Payment | null> {
    return Promise.resolve(
      this.transition(kindergartenId, id, ['completed'], (s) => ({
        ...s,
        status: 'refunded' as PaymentStatus,
        refundId,
        updatedAt: now,
      })),
    );
  }

  private transition(
    kindergartenId: string,
    id: string,
    expected: PaymentStatus[],
    patch: (s: PaymentState) => PaymentState,
  ): Payment | null {
    const p = this.rows.get(id);
    if (!p || p.kindergartenId !== kindergartenId) return null;
    if (!expected.includes(p.status)) return null;
    const updated = Payment.fromState(patch(p.toState()));
    this.rows.set(id, updated);
    return updated;
  }
}

class FakeInvoiceRepo extends InvoiceRepository {
  rows = new Map<string, Invoice>();
  paidSums = new Map<string, number>();
  paymentRepo: FakePaymentRepo | null = null;

  create(): Promise<Invoice> {
    return Promise.reject(new Error('not used'));
  }
  findById(_kg: string, id: string): Promise<Invoice | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }
  list(kg: string, _filter: ListInvoicesFilter): Promise<Invoice[]> {
    return Promise.resolve(
      [...this.rows.values()].filter((i) => i.kindergartenId === kg),
    );
  }
  findByChildId(_kg: string, childId: string): Promise<Invoice[]> {
    return Promise.resolve(
      [...this.rows.values()].filter((i) => i.childId === childId),
    );
  }
  existsAnyForPeriod(): Promise<boolean> {
    return Promise.resolve(false);
  }
  getPaidSumForInvoice(kg: string, invoiceId: string): Promise<number> {
    if (this.paidSums.has(invoiceId)) {
      return Promise.resolve(this.paidSums.get(invoiceId) ?? 0);
    }
    if (this.paymentRepo) {
      const sum = [...this.paymentRepo.rows.values()]
        .filter(
          (p) =>
            p.kindergartenId === kg &&
            p.invoiceId === invoiceId &&
            p.status === 'completed',
        )
        .reduce((acc, p) => acc + p.amount, 0);
      return Promise.resolve(sum);
    }
    return Promise.resolve(0);
  }
  markPaidConditional(
    _kg: string,
    id: string,
    now: Date,
  ): Promise<Invoice | null> {
    return Promise.resolve(
      this.flip(id, ['pending', 'partial', 'overdue'], 'paid', now),
    );
  }
  markPartialConditional(
    _kg: string,
    id: string,
    now: Date,
  ): Promise<Invoice | null> {
    return Promise.resolve(
      this.flip(id, ['pending', 'overdue'], 'partial', now),
    );
  }
  markCancelledConditional(
    _kg: string,
    id: string,
    now: Date,
  ): Promise<Invoice | null> {
    return Promise.resolve(
      this.flip(id, ['pending', 'partial', 'overdue'], 'cancelled', now),
    );
  }
  markRefundedConditional(
    _kg: string,
    id: string,
    now: Date,
  ): Promise<Invoice | null> {
    return Promise.resolve(this.flip(id, ['paid', 'partial'], 'refunded', now));
  }
  markOverdueConditional(
    _kg: string,
    id: string,
    now: Date,
  ): Promise<Invoice | null> {
    return Promise.resolve(this.flip(id, ['pending'], 'overdue', now));
  }
  acquireMonthlyGenerationAdvisoryLock(): Promise<void> {
    return Promise.resolve();
  }

  setPaidSum(invoiceId: string, sum: number): void {
    this.paidSums.set(invoiceId, sum);
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
    const s = inv.toState();
    const updated = Invoice.fromState({ ...s, status: next, updatedAt: now });
    this.rows.set(id, updated);
    return updated;
  }
}

class FakePaymentAccountRepo extends PaymentAccountRepository {
  rows = new Map<string, PaymentAccount>();

  put(a: PaymentAccount): void {
    this.rows.set(a.id, a);
  }

  findOrCreateForChild(
    kindergartenId: string,
    childId: string,
  ): Promise<PaymentAccount> {
    for (const a of this.rows.values()) {
      if (a.kindergartenId === kindergartenId && a.childId === childId) {
        return Promise.resolve(a);
      }
    }
    return Promise.reject(new Error('account not seeded'));
  }
  findById(_kg: string, id: string): Promise<PaymentAccount | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }
  findByChildId(
    kindergartenId: string,
    childId: string,
  ): Promise<PaymentAccount | null> {
    for (const a of this.rows.values()) {
      if (a.kindergartenId === kindergartenId && a.childId === childId)
        return Promise.resolve(a);
    }
    return Promise.resolve(null);
  }
  save(a: PaymentAccount): Promise<PaymentAccount> {
    this.rows.set(a.id, a);
    return Promise.resolve(a);
  }
}

class FakeFiscalReceiptPort extends FiscalReceiptPort {
  calls: EmitReceiptInput[] = [];
  emitImpl: (input: EmitReceiptInput) => Promise<EmitReceiptResult> = (input) =>
    Promise.resolve({
      fiscalSign: `mock_fiscal_${input.paymentId}`,
      ofdStatus: 'queued' as const,
    });

  emitReceipt(input: EmitReceiptInput): Promise<EmitReceiptResult> {
    this.calls.push(input);
    return this.emitImpl(input);
  }
}

class FakePaymentProvider extends PaymentProviderPort {
  createPaymentImpl: (
    input: CreatePaymentInput,
  ) => Promise<CreatePaymentResult> = (input) =>
    Promise.resolve({
      providerPaymentId: `mock_${input.invoiceId}_xyz`,
      redirectUrl: `https://mock/pay/${input.invoiceId}`,
      status: 'completed',
    });
  verifyWebhookImpl: (
    input: VerifyWebhookInput,
  ) => Promise<VerifyWebhookResult> = () =>
    Promise.reject(new WebhookSignatureInvalidError('mock'));
  refundImpl: (input: RefundInput) => Promise<RefundResult> = () =>
    Promise.resolve({ providerRefundId: 'r1', status: 'processed' });

  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    return this.createPaymentImpl(input);
  }
  verifyWebhook(input: VerifyWebhookInput): Promise<VerifyWebhookResult> {
    return this.verifyWebhookImpl(input);
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
    status: 'pending',
    dueDate: new Date('2026-06-10T00:00:00.000Z'),
    description: null,
    proratedForDays: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
  return Invoice.fromState(state);
}

function makeAccount(): PaymentAccount {
  return PaymentAccount.fromState({
    id: ACCOUNT,
    kindergartenId: KG,
    childId: CHILD,
    balance: 0,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

// DataSource fake — `transaction(cb)` invokes the callback with a stub
// EntityManager. PaymentService does not actually interact with the EM
// (the unit-level path does not exercise tenantStorage); this is enough
// for the webhook orchestration to run.
function makeFakeDataSource(): DataSource {
  return {
    transaction: <T>(cb: (em: EntityManager) => Promise<T>): Promise<T> =>
      cb({
        query: () => Promise.resolve(undefined),
      } as unknown as EntityManager),
  } as unknown as DataSource;
}

// ── Wiring ───────────────────────────────────────────────────────────────

interface Harness {
  service: PaymentService;
  paymentRepo: FakePaymentRepo;
  invoiceRepo: FakeInvoiceRepo;
  invoiceService: InvoiceService;
  paymentAccountService: PaymentAccountService;
  paymentAccountRepo: FakePaymentAccountRepo;
  provider: FakePaymentProvider;
  fiscal: FakeFiscalReceiptPort;
  notifier: InMemoryNotificationAdapter;
  clock: FixedClock;
}

function buildHarness(): Harness {
  const clock = new FixedClock(NOW);
  const paymentRepo = new FakePaymentRepo();
  const invoiceRepo = new FakeInvoiceRepo();
  invoiceRepo.paymentRepo = paymentRepo;
  const accountRepo = new FakePaymentAccountRepo();
  const accountService = new PaymentAccountService(accountRepo, clock);
  const provider = new FakePaymentProvider();
  const fiscal = new FakeFiscalReceiptPort();
  const notifier = new InMemoryNotificationAdapter();
  // InvoiceService.get is the only InvoiceService method PaymentService uses.
  // Provide a thin shim that delegates to invoiceRepo.findById.
  const invoiceService = {
    get: async (kg: string, id: string) => {
      const inv = await invoiceRepo.findById(kg, id);
      if (!inv) throw new InvoiceNotFoundError(id);
      return inv;
    },
  } as unknown as InvoiceService;
  const dataSource = makeFakeDataSource();
  const service = new PaymentService(
    paymentRepo,
    invoiceRepo,
    invoiceService,
    accountService,
    provider,
    fiscal,
    notifier,
    clock,
    dataSource,
  );
  return {
    service,
    paymentRepo,
    invoiceRepo,
    invoiceService,
    paymentAccountService: accountService,
    paymentAccountRepo: accountRepo,
    provider,
    fiscal,
    notifier,
    clock,
  };
}

// ─────────────────────────────────────────────────────────────────────────

describe('PaymentService.initiate', () => {
  it('returns existing payment when idempotency_key already used (no provider call)', async () => {
    const h = buildHarness();
    h.invoiceRepo.rows.set(INVOICE, makeInvoice());
    h.paymentAccountRepo.put(makeAccount());

    let providerCalls = 0;
    h.provider.createPaymentImpl = (_input) => {
      providerCalls++;
      return Promise.resolve({
        providerPaymentId: 'mock_first',
        status: 'completed',
        redirectUrl: 'https://mock/first',
      } as CreatePaymentResult);
    };

    const first = await h.service.initiate(KG, {
      invoiceId: INVOICE,
      amount: 50000,
      paymentMode: 'full',
      provider: 'mock',
      idempotencyKey: 'idem-1',
      payerUserId: PAYER,
      returnUrl: 'https://app/return',
    });

    const second = await h.service.initiate(KG, {
      invoiceId: INVOICE,
      amount: 50000,
      paymentMode: 'full',
      provider: 'mock',
      idempotencyKey: 'idem-1',
      payerUserId: PAYER,
      returnUrl: 'https://app/return',
    });

    expect(providerCalls).toBe(1);
    expect(second.payment.id).toBe(first.payment.id);
  });

  it('throws InvoiceNotFoundError when invoice missing', async () => {
    const h = buildHarness();
    await expect(
      h.service.initiate(KG, {
        invoiceId: 'no-such',
        amount: 1,
        paymentMode: 'full',
        provider: 'mock',
        idempotencyKey: 'idem-2',
        returnUrl: 'https://app/return',
      }),
    ).rejects.toBeInstanceOf(InvoiceNotFoundError);
  });

  it('throws InvoiceAlreadyPaidError when invoice is already paid', async () => {
    const h = buildHarness();
    h.invoiceRepo.rows.set(INVOICE, makeInvoice({ status: 'paid' }));
    await expect(
      h.service.initiate(KG, {
        invoiceId: INVOICE,
        amount: 50000,
        paymentMode: 'full',
        provider: 'mock',
        idempotencyKey: 'idem-3',
        returnUrl: 'https://app/return',
      }),
    ).rejects.toBeInstanceOf(InvoiceAlreadyPaidError);
  });

  it('throws InvoiceAlreadyPaidError when invoice is refunded', async () => {
    const h = buildHarness();
    h.invoiceRepo.rows.set(INVOICE, makeInvoice({ status: 'refunded' }));
    await expect(
      h.service.initiate(KG, {
        invoiceId: INVOICE,
        amount: 50000,
        paymentMode: 'full',
        provider: 'mock',
        idempotencyKey: 'idem-4',
        returnUrl: 'https://app/return',
      }),
    ).rejects.toBeInstanceOf(InvoiceAlreadyPaidError);
  });

  it('throws InvoiceStatusInvalidError when invoice is cancelled', async () => {
    const h = buildHarness();
    h.invoiceRepo.rows.set(INVOICE, makeInvoice({ status: 'cancelled' }));
    await expect(
      h.service.initiate(KG, {
        invoiceId: INVOICE,
        amount: 50000,
        paymentMode: 'full',
        provider: 'mock',
        idempotencyKey: 'idem-5',
        returnUrl: 'https://app/return',
      }),
    ).rejects.toBeInstanceOf(InvoiceStatusInvalidError);
  });

  it('throws InvoiceStatusInvalidError when amount mismatches full-pay remaining', async () => {
    const h = buildHarness();
    h.invoiceRepo.rows.set(INVOICE, makeInvoice());
    h.paymentAccountRepo.put(makeAccount());
    await expect(
      h.service.initiate(KG, {
        invoiceId: INVOICE,
        amount: 49000, // expected 50000
        paymentMode: 'full',
        provider: 'mock',
        idempotencyKey: 'idem-6',
        returnUrl: 'https://app/return',
      }),
    ).rejects.toBeInstanceOf(InvoiceStatusInvalidError);
  });

  it('throws InvoiceStatusInvalidError when partial amount exceeds remaining', async () => {
    const h = buildHarness();
    h.invoiceRepo.rows.set(INVOICE, makeInvoice());
    h.paymentAccountRepo.put(makeAccount());
    await expect(
      h.service.initiate(KG, {
        invoiceId: INVOICE,
        amount: 50001,
        paymentMode: 'partial',
        provider: 'mock',
        idempotencyKey: 'idem-6b',
        returnUrl: 'https://app/return',
      }),
    ).rejects.toBeInstanceOf(InvoiceStatusInvalidError);
  });

  it('throws InvoiceStatusInvalidError when partial amount is zero or negative', async () => {
    const h = buildHarness();
    h.invoiceRepo.rows.set(INVOICE, makeInvoice());
    h.paymentAccountRepo.put(makeAccount());
    await expect(
      h.service.initiate(KG, {
        invoiceId: INVOICE,
        amount: 0,
        paymentMode: 'partial',
        provider: 'mock',
        idempotencyKey: 'idem-6c',
        returnUrl: 'https://app/return',
      }),
    ).rejects.toBeInstanceOf(InvoiceStatusInvalidError);
  });

  it('returns payment + redirectUrl when provider returns initiated (async path)', async () => {
    const h = buildHarness();
    h.invoiceRepo.rows.set(INVOICE, makeInvoice());
    h.paymentAccountRepo.put(makeAccount());
    h.provider.createPaymentImpl = () =>
      Promise.resolve({
        providerPaymentId: 'tx_async',
        status: 'initiated',
        redirectUrl: 'https://halyk/async',
      });

    const result = await h.service.initiate(KG, {
      invoiceId: INVOICE,
      amount: 50000,
      paymentMode: 'full',
      provider: 'mock',
      idempotencyKey: 'idem-7',
      returnUrl: 'https://app/return',
    });

    expect(result.redirectUrl).toBe('https://halyk/async');
    expect(result.payment.status).toBe('processing');
  });

  it('marks payment completed and applies to invoice when provider returns completed (synchronous Mock)', async () => {
    const h = buildHarness();
    h.invoiceRepo.rows.set(INVOICE, makeInvoice());
    h.paymentAccountRepo.put(makeAccount());
    // Mock fake by default returns completed.
    const result = await h.service.initiate(KG, {
      invoiceId: INVOICE,
      amount: 50000,
      paymentMode: 'full',
      provider: 'mock',
      idempotencyKey: 'idem-8',
      returnUrl: 'https://app/return',
    });

    expect(result.payment.status).toBe('completed');
    const invAfter = await h.invoiceRepo.findById(KG, INVOICE);
    expect(invAfter?.status).toBe('paid');
  });

  it('credits payment_account when payment completes synchronously', async () => {
    const h = buildHarness();
    h.invoiceRepo.rows.set(INVOICE, makeInvoice());
    h.paymentAccountRepo.put(makeAccount());

    await h.service.initiate(KG, {
      invoiceId: INVOICE,
      amount: 50000,
      paymentMode: 'full',
      provider: 'mock',
      idempotencyKey: 'idem-9',
      returnUrl: 'https://app/return',
    });

    const account = await h.paymentAccountRepo.findById(KG, ACCOUNT);
    expect(account?.balance).toBe(50000);
  });

  it('marks payment failed and rethrows PaymentProviderError when provider createPayment throws', async () => {
    const h = buildHarness();
    h.invoiceRepo.rows.set(INVOICE, makeInvoice());
    h.paymentAccountRepo.put(makeAccount());
    h.provider.createPaymentImpl = () =>
      Promise.reject(new Error('halyk_timeout'));

    await expect(
      h.service.initiate(KG, {
        invoiceId: INVOICE,
        amount: 50000,
        paymentMode: 'full',
        provider: 'halyk_epay',
        idempotencyKey: 'idem-10',
        returnUrl: 'https://app/return',
      }),
    ).rejects.toBeInstanceOf(PaymentProviderError);

    const all = await h.paymentRepo.list(KG, {});
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('failed');
  });

  it('handles 23505 idempotency race by re-fetching existing payment', async () => {
    const h = buildHarness();
    h.invoiceRepo.rows.set(INVOICE, makeInvoice());
    h.paymentAccountRepo.put(makeAccount());

    // Pre-seed a payment with the same idempotency_key, then disable
    // findByIdempotencyKey for the first read to simulate a race where
    // the second caller's pre-check missed the row that another writer
    // had just inserted. The repo's create call still rejects with
    // PaymentIdempotencyConflictError; the service should catch it and
    // re-read.
    const seeded = Payment.fromState({
      id: 'race-seeded-id',
      kindergartenId: KG,
      invoiceId: INVOICE,
      childId: CHILD,
      payerUserId: PAYER,
      amount: 50000,
      provider: 'mock',
      providerTxnId: 'tx_seed',
      idempotencyKey: 'idem-race',
      status: 'initiated',
      providerPayload: { redirect_url: 'https://seed' },
      paidAt: null,
      refundId: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    h.paymentRepo.rows.set(seeded.id, seeded);
    // Pin paidSum to 0 so the auto-computed branch in the fake doesn't
    // double-count the seeded row's amount.
    h.invoiceRepo.setPaidSum(INVOICE, 0);

    // Force the service's pre-check to miss the seeded row exactly once.
    const realFind = h.paymentRepo.findByIdempotencyKey.bind(h.paymentRepo);
    let firstFindCall = true;
    jest
      .spyOn(h.paymentRepo, 'findByIdempotencyKey')
      .mockImplementation((kg, key) => {
        if (firstFindCall) {
          firstFindCall = false;
          return Promise.resolve(null);
        }
        return realFind(kg, key);
      });

    const result = await h.service.initiate(KG, {
      invoiceId: INVOICE,
      amount: 50000,
      paymentMode: 'full',
      provider: 'mock',
      idempotencyKey: 'idem-race',
      returnUrl: 'https://app/return',
    });
    expect(result.payment.id).toBe('race-seeded-id');
  });

  it('does not call provider when idempotency replay returns the existing row', async () => {
    const h = buildHarness();
    h.invoiceRepo.rows.set(INVOICE, makeInvoice());
    h.paymentAccountRepo.put(makeAccount());
    let calls = 0;
    h.provider.createPaymentImpl = () => {
      calls++;
      return Promise.resolve({
        providerPaymentId: 'mock_x',
        status: 'completed',
      });
    };
    await h.service.initiate(KG, {
      invoiceId: INVOICE,
      amount: 50000,
      paymentMode: 'full',
      provider: 'mock',
      idempotencyKey: 'idem-rep',
      returnUrl: 'https://app/return',
    });
    await h.service.initiate(KG, {
      invoiceId: INVOICE,
      amount: 50000,
      paymentMode: 'full',
      provider: 'mock',
      idempotencyKey: 'idem-rep',
      returnUrl: 'https://app/return',
    });
    expect(calls).toBe(1);
  });
});

describe('PaymentService.processWebhook', () => {
  it('throws WebhookSignatureInvalidError when verify rejects', async () => {
    const h = buildHarness();
    h.provider.verifyWebhookImpl = () =>
      Promise.reject(new WebhookSignatureInvalidError('mock'));
    await expect(
      h.service.processWebhook({
        provider: 'mock',
        headers: {},
        body: {},
      }),
    ).rejects.toBeInstanceOf(WebhookSignatureInvalidError);
  });

  it('throws PaymentNotFoundError when provider tx unknown', async () => {
    const h = buildHarness();
    h.provider.verifyWebhookImpl = () =>
      Promise.resolve({
        providerPaymentId: 'tx_unknown',
        status: 'completed',
        raw: {},
      });
    await expect(
      h.service.processWebhook({
        provider: 'mock',
        headers: { 'x-mock-signature': 'valid' },
        body: { provider_payment_id: 'tx_unknown', status: 'completed' },
      }),
    ).rejects.toBeInstanceOf(PaymentNotFoundError);
  });

  it('marks payment completed and flips invoice to paid atomically (full sum)', async () => {
    const h = buildHarness();
    const invoice = makeInvoice();
    h.invoiceRepo.rows.set(INVOICE, invoice);
    h.paymentAccountRepo.put(makeAccount());

    // Seed an initiated payment.
    const seeded = Payment.fromState({
      id: 'pmt-1',
      kindergartenId: KG,
      invoiceId: INVOICE,
      childId: CHILD,
      payerUserId: PAYER,
      amount: 50000,
      provider: 'mock',
      providerTxnId: 'tx_async_1',
      idempotencyKey: 'idem-w-1',
      status: 'initiated',
      providerPayload: null,
      paidAt: null,
      refundId: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    h.paymentRepo.rows.set(seeded.id, seeded);
    // Ensure paid_sum reflects this payment after completion.
    h.invoiceRepo.setPaidSum(INVOICE, 50000);

    h.provider.verifyWebhookImpl = () =>
      Promise.resolve({
        providerPaymentId: 'tx_async_1',
        status: 'completed',
        raw: { provider_payment_id: 'tx_async_1', status: 'completed' },
      });

    const result = await h.service.processWebhook({
      provider: 'mock',
      headers: { 'x-mock-signature': 'valid' },
      body: {},
    });
    expect(result.status).toBe('completed');

    const after = await h.paymentRepo.findById(KG, 'pmt-1');
    expect(after?.status).toBe('completed');
    const invAfter = await h.invoiceRepo.findById(KG, INVOICE);
    expect(invAfter?.status).toBe('paid');
  });

  it('credits payment_account on completion', async () => {
    const h = buildHarness();
    h.invoiceRepo.rows.set(INVOICE, makeInvoice());
    h.paymentAccountRepo.put(makeAccount());
    const seeded = Payment.fromState({
      id: 'pmt-2',
      kindergartenId: KG,
      invoiceId: INVOICE,
      childId: CHILD,
      payerUserId: PAYER,
      amount: 50000,
      provider: 'mock',
      providerTxnId: 'tx_async_2',
      idempotencyKey: 'idem-w-2',
      status: 'initiated',
      providerPayload: null,
      paidAt: null,
      refundId: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    h.paymentRepo.rows.set(seeded.id, seeded);
    h.invoiceRepo.setPaidSum(INVOICE, 50000);
    h.provider.verifyWebhookImpl = () =>
      Promise.resolve({
        providerPaymentId: 'tx_async_2',
        status: 'completed',
        raw: {},
      });

    await h.service.processWebhook({
      provider: 'mock',
      headers: { 'x-mock-signature': 'valid' },
      body: {},
    });
    const acc = await h.paymentAccountRepo.findById(KG, ACCOUNT);
    expect(acc?.balance).toBe(50000);
  });

  it('is idempotent on replay (already completed payment is a no-op)', async () => {
    const h = buildHarness();
    h.invoiceRepo.rows.set(INVOICE, makeInvoice({ status: 'paid' }));
    const account = makeAccount();
    account.credit(50000, NOW);
    h.paymentAccountRepo.put(account);
    const seeded = Payment.fromState({
      id: 'pmt-r',
      kindergartenId: KG,
      invoiceId: INVOICE,
      childId: CHILD,
      payerUserId: PAYER,
      amount: 50000,
      provider: 'mock',
      providerTxnId: 'tx_replay',
      idempotencyKey: 'idem-replay',
      status: 'completed',
      providerPayload: null,
      paidAt: NOW,
      refundId: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    h.paymentRepo.rows.set(seeded.id, seeded);
    h.invoiceRepo.setPaidSum(INVOICE, 50000);

    h.provider.verifyWebhookImpl = () =>
      Promise.resolve({
        providerPaymentId: 'tx_replay',
        status: 'completed',
        raw: {},
      });

    await h.service.processWebhook({
      provider: 'mock',
      headers: { 'x-mock-signature': 'valid' },
      body: {},
    });

    const acc = await h.paymentAccountRepo.findById(KG, ACCOUNT);
    // Balance unchanged — initial credit + no double-credit.
    expect(acc?.balance).toBe(50000);
  });

  it('marks invoice partial when paidSum < amountAfterDiscount', async () => {
    const h = buildHarness();
    h.invoiceRepo.rows.set(INVOICE, makeInvoice());
    h.paymentAccountRepo.put(makeAccount());
    const seeded = Payment.fromState({
      id: 'pmt-p',
      kindergartenId: KG,
      invoiceId: INVOICE,
      childId: CHILD,
      payerUserId: PAYER,
      amount: 20000,
      provider: 'mock',
      providerTxnId: 'tx_part',
      idempotencyKey: 'idem-part',
      status: 'initiated',
      providerPayload: null,
      paidAt: null,
      refundId: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    h.paymentRepo.rows.set(seeded.id, seeded);
    h.invoiceRepo.setPaidSum(INVOICE, 20000);
    h.provider.verifyWebhookImpl = () =>
      Promise.resolve({
        providerPaymentId: 'tx_part',
        status: 'completed',
        raw: {},
      });

    await h.service.processWebhook({
      provider: 'mock',
      headers: { 'x-mock-signature': 'valid' },
      body: {},
    });
    const inv = await h.invoiceRepo.findById(KG, INVOICE);
    expect(inv?.status).toBe('partial');
  });

  it('marks invoice paid when paidSum >= amountAfterDiscount on multi-payment flow', async () => {
    const h = buildHarness();
    h.invoiceRepo.rows.set(INVOICE, makeInvoice({ status: 'partial' }));
    h.paymentAccountRepo.put(makeAccount());
    const seeded = Payment.fromState({
      id: 'pmt-final',
      kindergartenId: KG,
      invoiceId: INVOICE,
      childId: CHILD,
      payerUserId: PAYER,
      amount: 30000,
      provider: 'mock',
      providerTxnId: 'tx_final',
      idempotencyKey: 'idem-final',
      status: 'initiated',
      providerPayload: null,
      paidAt: null,
      refundId: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    h.paymentRepo.rows.set(seeded.id, seeded);
    h.invoiceRepo.setPaidSum(INVOICE, 50000);
    h.provider.verifyWebhookImpl = () =>
      Promise.resolve({
        providerPaymentId: 'tx_final',
        status: 'completed',
        raw: {},
      });

    await h.service.processWebhook({
      provider: 'mock',
      headers: { 'x-mock-signature': 'valid' },
      body: {},
    });
    const inv = await h.invoiceRepo.findById(KG, INVOICE);
    expect(inv?.status).toBe('paid');
  });

  it('marks payment failed when provider reports failure', async () => {
    const h = buildHarness();
    h.invoiceRepo.rows.set(INVOICE, makeInvoice());
    h.paymentAccountRepo.put(makeAccount());
    const seeded = Payment.fromState({
      id: 'pmt-f',
      kindergartenId: KG,
      invoiceId: INVOICE,
      childId: CHILD,
      payerUserId: PAYER,
      amount: 50000,
      provider: 'mock',
      providerTxnId: 'tx_fail',
      idempotencyKey: 'idem-fail',
      status: 'initiated',
      providerPayload: null,
      paidAt: null,
      refundId: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    h.paymentRepo.rows.set(seeded.id, seeded);
    h.provider.verifyWebhookImpl = () =>
      Promise.resolve({
        providerPaymentId: 'tx_fail',
        status: 'failed',
        failureReason: 'insufficient_funds',
        raw: {},
      });

    const result = await h.service.processWebhook({
      provider: 'mock',
      headers: { 'x-mock-signature': 'valid' },
      body: {},
    });
    expect(result.status).toBe('failed');
    const after = await h.paymentRepo.findById(KG, 'pmt-f');
    expect(after?.status).toBe('failed');
    // Invoice untouched.
    const inv = await h.invoiceRepo.findById(KG, INVOICE);
    expect(inv?.status).toBe('pending');
  });

  it('cross-tenant lookup returns the correct kg-scoped payment', async () => {
    const h = buildHarness();
    // kg_A invoice + payment.
    h.invoiceRepo.rows.set(INVOICE, makeInvoice());
    h.paymentAccountRepo.put(makeAccount());
    const pA = Payment.fromState({
      id: 'pmt-A',
      kindergartenId: KG,
      invoiceId: INVOICE,
      childId: CHILD,
      payerUserId: PAYER,
      amount: 50000,
      provider: 'mock',
      providerTxnId: 'tx_kgA',
      idempotencyKey: 'idem-kgA',
      status: 'initiated',
      providerPayload: null,
      paidAt: null,
      refundId: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    h.paymentRepo.rows.set(pA.id, pA);
    // kg_B unrelated payment with a different provider_txn_id.
    const pB = Payment.fromState({
      id: 'pmt-B',
      kindergartenId: KG_OTHER,
      invoiceId: 'inv-B',
      childId: 'ch-B',
      payerUserId: null,
      amount: 10000,
      provider: 'mock',
      providerTxnId: 'tx_kgB',
      idempotencyKey: 'idem-kgB',
      status: 'initiated',
      providerPayload: null,
      paidAt: null,
      refundId: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    h.paymentRepo.rows.set(pB.id, pB);
    h.invoiceRepo.setPaidSum(INVOICE, 50000);
    h.provider.verifyWebhookImpl = () =>
      Promise.resolve({
        providerPaymentId: 'tx_kgA',
        status: 'completed',
        raw: {},
      });

    const result = await h.service.processWebhook({
      provider: 'mock',
      headers: { 'x-mock-signature': 'valid' },
      body: {},
    });
    expect(result.paymentId).toBe('pmt-A');
    expect((await h.paymentRepo.findById(KG, 'pmt-A'))?.status).toBe(
      'completed',
    );
    expect((await h.paymentRepo.findById(KG_OTHER, 'pmt-B'))?.status).toBe(
      'initiated',
    );
  });

  // ── T5c: fiscal emit + outbox notifications ─────────────────────────────

  it('emits fiscal receipt on successful completion', async () => {
    const h = buildHarness();
    h.invoiceRepo.rows.set(INVOICE, makeInvoice());
    h.paymentAccountRepo.put(makeAccount());
    const seeded = Payment.fromState({
      id: 'pmt-fiscal',
      kindergartenId: KG,
      invoiceId: INVOICE,
      childId: CHILD,
      payerUserId: PAYER,
      amount: 50000,
      provider: 'mock',
      providerTxnId: 'tx_fiscal',
      idempotencyKey: 'idem-fiscal',
      status: 'initiated',
      providerPayload: null,
      paidAt: null,
      refundId: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    h.paymentRepo.rows.set(seeded.id, seeded);
    h.invoiceRepo.setPaidSum(INVOICE, 50000);
    h.provider.verifyWebhookImpl = () =>
      Promise.resolve({
        providerPaymentId: 'tx_fiscal',
        status: 'completed',
        raw: {},
      });

    await h.service.processWebhook({
      provider: 'mock',
      headers: { 'x-mock-signature': 'valid' },
      body: {},
    });

    expect(h.fiscal.calls).toHaveLength(1);
    expect(h.fiscal.calls[0]).toMatchObject({
      paymentId: 'pmt-fiscal',
      invoiceId: INVOICE,
      kindergartenId: KG,
      amountKzt: 50000,
    });
  });

  it('logs fiscal failure and continues completing the payment (does not abort TX)', async () => {
    const h = buildHarness();
    h.invoiceRepo.rows.set(INVOICE, makeInvoice());
    h.paymentAccountRepo.put(makeAccount());
    h.fiscal.emitImpl = () => Promise.reject(new Error('ofd_5xx'));
    const seeded = Payment.fromState({
      id: 'pmt-fiscal-fail',
      kindergartenId: KG,
      invoiceId: INVOICE,
      childId: CHILD,
      payerUserId: PAYER,
      amount: 50000,
      provider: 'mock',
      providerTxnId: 'tx_fiscal_fail',
      idempotencyKey: 'idem-fiscal-fail',
      status: 'initiated',
      providerPayload: null,
      paidAt: null,
      refundId: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    h.paymentRepo.rows.set(seeded.id, seeded);
    h.invoiceRepo.setPaidSum(INVOICE, 50000);
    h.provider.verifyWebhookImpl = () =>
      Promise.resolve({
        providerPaymentId: 'tx_fiscal_fail',
        status: 'completed',
        raw: {},
      });

    const result = await h.service.processWebhook({
      provider: 'mock',
      headers: { 'x-mock-signature': 'valid' },
      body: {},
    });

    expect(result.status).toBe('completed');
    const after = await h.paymentRepo.findById(KG, 'pmt-fiscal-fail');
    expect(after?.status).toBe('completed');
    const inv = await h.invoiceRepo.findById(KG, INVOICE);
    expect(inv?.status).toBe('paid');
  });

  it('emits payment.completed + invoice.paid outbox events when the invoice flips to paid', async () => {
    const h = buildHarness();
    h.invoiceRepo.rows.set(INVOICE, makeInvoice());
    h.paymentAccountRepo.put(makeAccount());
    const seeded = Payment.fromState({
      id: 'pmt-evt',
      kindergartenId: KG,
      invoiceId: INVOICE,
      childId: CHILD,
      payerUserId: PAYER,
      amount: 50000,
      provider: 'mock',
      providerTxnId: 'tx_evt',
      idempotencyKey: 'idem-evt',
      status: 'initiated',
      providerPayload: null,
      paidAt: null,
      refundId: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    h.paymentRepo.rows.set(seeded.id, seeded);
    h.invoiceRepo.setPaidSum(INVOICE, 50000);
    h.provider.verifyWebhookImpl = () =>
      Promise.resolve({
        providerPaymentId: 'tx_evt',
        status: 'completed',
        raw: {},
      });

    await h.service.processWebhook({
      provider: 'mock',
      headers: { 'x-mock-signature': 'valid' },
      body: {},
    });

    const types = h.notifier.events.map((e) => e.type);
    expect(types).toContain('payment_completed');
    expect(types).toContain('invoice_paid');
  });

  it('emits only payment.completed (NOT invoice.paid) when invoice transitions to partial', async () => {
    const h = buildHarness();
    h.invoiceRepo.rows.set(INVOICE, makeInvoice());
    h.paymentAccountRepo.put(makeAccount());
    const seeded = Payment.fromState({
      id: 'pmt-evt-p',
      kindergartenId: KG,
      invoiceId: INVOICE,
      childId: CHILD,
      payerUserId: PAYER,
      amount: 20000,
      provider: 'mock',
      providerTxnId: 'tx_evt_p',
      idempotencyKey: 'idem-evt-p',
      status: 'initiated',
      providerPayload: null,
      paidAt: null,
      refundId: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    h.paymentRepo.rows.set(seeded.id, seeded);
    h.invoiceRepo.setPaidSum(INVOICE, 20000);
    h.provider.verifyWebhookImpl = () =>
      Promise.resolve({
        providerPaymentId: 'tx_evt_p',
        status: 'completed',
        raw: {},
      });

    await h.service.processWebhook({
      provider: 'mock',
      headers: { 'x-mock-signature': 'valid' },
      body: {},
    });

    const types = h.notifier.events.map((e) => e.type);
    expect(types).toContain('payment_completed');
    expect(types).not.toContain('invoice_paid');
  });

  it('emits payment.failed outbox event on webhook failure', async () => {
    const h = buildHarness();
    h.invoiceRepo.rows.set(INVOICE, makeInvoice());
    h.paymentAccountRepo.put(makeAccount());
    const seeded = Payment.fromState({
      id: 'pmt-fail-evt',
      kindergartenId: KG,
      invoiceId: INVOICE,
      childId: CHILD,
      payerUserId: PAYER,
      amount: 50000,
      provider: 'mock',
      providerTxnId: 'tx_fail_evt',
      idempotencyKey: 'idem-fail-evt',
      status: 'initiated',
      providerPayload: null,
      paidAt: null,
      refundId: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    h.paymentRepo.rows.set(seeded.id, seeded);
    h.provider.verifyWebhookImpl = () =>
      Promise.resolve({
        providerPaymentId: 'tx_fail_evt',
        status: 'failed',
        failureReason: 'insufficient_funds',
        raw: {},
      });

    await h.service.processWebhook({
      provider: 'mock',
      headers: { 'x-mock-signature': 'valid' },
      body: {},
    });

    const types = h.notifier.events.map((e) => e.type);
    expect(types).toContain('payment_failed');
    expect(h.fiscal.calls).toHaveLength(0);
  });
});

describe('PaymentService.markFailed / getById / list', () => {
  it('markFailed flips initiated → failed', async () => {
    const h = buildHarness();
    const seeded = Payment.fromState({
      id: 'pmt-mf',
      kindergartenId: KG,
      invoiceId: INVOICE,
      childId: CHILD,
      payerUserId: PAYER,
      amount: 1000,
      provider: 'mock',
      providerTxnId: null,
      idempotencyKey: 'idem-mf',
      status: 'initiated',
      providerPayload: null,
      paidAt: null,
      refundId: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    h.paymentRepo.rows.set(seeded.id, seeded);
    const out = await h.service.markFailed(KG, 'pmt-mf', 'admin-cancel');
    expect(out.status).toBe('failed');
  });

  it('markFailed throws PaymentNotFoundError when row missing', async () => {
    const h = buildHarness();
    await expect(
      h.service.markFailed(KG, 'no-such', 'reason'),
    ).rejects.toBeInstanceOf(PaymentNotFoundError);
  });

  it('markFailed throws PaymentStatusInvalidError when row is terminal', async () => {
    const h = buildHarness();
    const seeded = Payment.fromState({
      id: 'pmt-term',
      kindergartenId: KG,
      invoiceId: INVOICE,
      childId: CHILD,
      payerUserId: PAYER,
      amount: 1000,
      provider: 'mock',
      providerTxnId: 'tx',
      idempotencyKey: 'idem-term',
      status: 'completed',
      providerPayload: null,
      paidAt: NOW,
      refundId: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    h.paymentRepo.rows.set(seeded.id, seeded);
    await expect(
      h.service.markFailed(KG, 'pmt-term', 'reason'),
    ).rejects.toBeInstanceOf(PaymentStatusInvalidError);
  });

  it('getById returns the payment', async () => {
    const h = buildHarness();
    const seeded = Payment.fromState({
      id: 'pmt-get',
      kindergartenId: KG,
      invoiceId: INVOICE,
      childId: CHILD,
      payerUserId: PAYER,
      amount: 1,
      provider: 'mock',
      providerTxnId: null,
      idempotencyKey: 'idem-get',
      status: 'initiated',
      providerPayload: null,
      paidAt: null,
      refundId: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    h.paymentRepo.rows.set(seeded.id, seeded);
    const out = await h.service.getById(KG, 'pmt-get');
    expect(out.id).toBe('pmt-get');
  });

  it('getById throws PaymentNotFoundError when missing', async () => {
    const h = buildHarness();
    await expect(h.service.getById(KG, 'absent')).rejects.toBeInstanceOf(
      PaymentNotFoundError,
    );
  });

  it('list returns kg-scoped rows applying filters', async () => {
    const h = buildHarness();
    const seedRow = (id: string, status: PaymentStatus) =>
      h.paymentRepo.rows.set(
        id,
        Payment.fromState({
          id,
          kindergartenId: KG,
          invoiceId: INVOICE,
          childId: CHILD,
          payerUserId: PAYER,
          amount: 100,
          provider: 'mock',
          providerTxnId: null,
          idempotencyKey: `idem-${id}`,
          status,
          providerPayload: null,
          paidAt: null,
          refundId: null,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      );
    seedRow('p1', 'initiated');
    seedRow('p2', 'completed');
    seedRow('p3', 'failed');

    const all = await h.service.list(KG, {});
    expect(all).toHaveLength(3);
    const ok = await h.service.list(KG, { status: 'completed' });
    expect(ok).toHaveLength(1);
    expect(ok[0].id).toBe('p2');
  });
});
