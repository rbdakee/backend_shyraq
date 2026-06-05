import { Payment, PaymentState } from './domain/entities/payment.entity';
import { ParsedRemoteDetails } from './infrastructure/payment-provider/kaspi/kaspi-remote-details';
import { VerifyWebhookResult } from './infrastructure/payment-provider/payment-provider.port';
import { KASPI_POLL_HARD_CAP_MS } from './kaspi-payment-status.constants';
import { KaspiPaymentStatusPollerService } from './kaspi-payment-status-poller.service';
import { MoneyKzt } from '@/shared-kernel/domain/money-kzt';

// ── fixed clock ────────────────────────────────────────────────────────────
const NOW = new Date('2026-06-04T12:00:00.000Z');

class FakeClock {
  constructor(private current: Date = NOW) {}
  now(): Date {
    return this.current;
  }
  set(d: Date): void {
    this.current = d;
  }
}

// ── transaction runner: runs cb with a no-op em ────────────────────────────
class FakeTxRunner {
  run<T>(cb: (em: unknown) => Promise<T>): Promise<T> {
    const em = { query: () => Promise.resolve(undefined) };
    return cb(em);
  }
}

// ── KaspiPaymentProvider.getPaymentStatus stub ─────────────────────────────
class FakeKaspiProvider {
  canned: ParsedRemoteDetails | null = null;
  throwErr: Error | null = null;
  calls: Array<{ kindergartenId: string; providerPaymentId: string }> = [];

  getPaymentStatus(input: {
    kindergartenId: string;
    providerPaymentId: string;
  }): Promise<ParsedRemoteDetails> {
    this.calls.push(input);
    if (this.throwErr) return Promise.reject(this.throwErr);
    if (!this.canned) return Promise.reject(new Error('no canned details'));
    return Promise.resolve(this.canned);
  }
}

// ── PaymentRepository (only findByIdCrossTenant) ───────────────────────────
class FakePaymentRepo {
  payment: Payment | null = null;
  findByIdCrossTenant(): Promise<Payment | null> {
    return Promise.resolve(this.payment);
  }
}

// ── PaymentService.settleFromKaspiPoller spy ───────────────────────────────
class FakePaymentService {
  settleCalls: Array<{
    kindergartenId: string;
    paymentId: string;
    terminal: VerifyWebhookResult;
  }> = [];

  settleFromKaspiPoller(
    kindergartenId: string,
    paymentId: string,
    terminal: VerifyWebhookResult,
  ): Promise<{ paymentId: string; status: string }> {
    this.settleCalls.push({ kindergartenId, paymentId, terminal });
    return Promise.resolve({ paymentId, status: terminal.status });
  }
}

// ── KaspiConnectService.refreshSession spy ─────────────────────────────────
class FakeKaspiConnect {
  shouldThrow = false;
  refreshCalls = 0;
  refreshSession(): Promise<unknown> {
    this.refreshCalls += 1;
    if (this.shouldThrow)
      return Promise.reject(new Error('sign_in_lite_failed'));
    return Promise.resolve({});
  }
}

// ── KaspiMerchantSessionRepository.touchLastCheckedAtBypassRls ──────────────
class FakeSessionRepo {
  touchCalls = 0;
  touchLastCheckedAtBypassRls(): Promise<void> {
    this.touchCalls += 1;
    return Promise.resolve();
  }
}

// ── StaffMemberRepository.listByKindergarten ───────────────────────────────
class FakeStaffRepo {
  admins: Array<{ userId: string }> = [];
  listByKindergarten(): Promise<Array<{ toState: () => { userId: string } }>> {
    return Promise.resolve(
      this.admins.map((a) => ({ toState: () => ({ userId: a.userId }) })),
    );
  }
}

// ── NotificationPort (records notifyKaspiSessionExpired) ───────────────────
class FakeNotificationPort {
  sessionExpiredCalls: Array<{
    kindergartenId: string;
    recipientUserIds: string[];
  }> = [];
  notifyKaspiSessionExpired(e: {
    kindergartenId: string;
    recipientUserIds: string[];
  }): Promise<void> {
    this.sessionExpiredCalls.push(e);
    return Promise.resolve();
  }
}

// ── helpers ────────────────────────────────────────────────────────────────
const KG = 'kg-1';
const PAYMENT_ID = 'pay-1';
const QR_OP = 'qr-op-123';

function makePayment(overrides: Partial<PaymentState> = {}): Payment {
  const state: PaymentState = {
    id: PAYMENT_ID,
    kindergartenId: KG,
    invoiceId: 'inv-1',
    childId: 'child-1',
    payerUserId: null,
    amount: MoneyKzt.fromKzt(1000),
    provider: 'kaspi_pay',
    providerTxnId: QR_OP,
    idempotencyKey: 'idem-1',
    status: 'processing',
    providerPayload: null,
    paidAt: null,
    refundId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
  return Payment.fromState(state);
}

interface Harness {
  service: KaspiPaymentStatusPollerService;
  provider: FakeKaspiProvider;
  paymentRepo: FakePaymentRepo;
  paymentService: FakePaymentService;
  kaspiConnect: FakeKaspiConnect;
  sessionRepo: FakeSessionRepo;
  staffRepo: FakeStaffRepo;
  notifier: FakeNotificationPort;
  clock: FakeClock;
}

function makeHarness(): Harness {
  const provider = new FakeKaspiProvider();
  const paymentRepo = new FakePaymentRepo();
  const paymentService = new FakePaymentService();
  const kaspiConnect = new FakeKaspiConnect();
  const sessionRepo = new FakeSessionRepo();
  const staffRepo = new FakeStaffRepo();
  const notifier = new FakeNotificationPort();
  const clock = new FakeClock();
  const service = new KaspiPaymentStatusPollerService(
    provider as never,
    paymentService as never,
    paymentRepo as never,
    kaspiConnect as never,
    sessionRepo as never,
    staffRepo as never,
    notifier as never,
    new FakeTxRunner() as never,
    clock as never,
  );
  return {
    service,
    provider,
    paymentRepo,
    paymentService,
    kaspiConnect,
    sessionRepo,
    staffRepo,
    notifier,
    clock,
  };
}

describe('KaspiPaymentStatusPollerService.pollOnce', () => {
  it('returns stop when the payment is not found', async () => {
    const h = makeHarness();
    h.paymentRepo.payment = null;
    const r = await h.service.pollOnce(KG, PAYMENT_ID);
    expect(r.outcome).toBe('stop');
    expect(h.provider.calls).toHaveLength(0);
  });

  it('returns stop for an already-terminal payment', async () => {
    const h = makeHarness();
    h.paymentRepo.payment = makePayment({ status: 'completed' });
    const r = await h.service.pollOnce(KG, PAYMENT_ID);
    expect(r.outcome).toBe('stop');
    expect(h.provider.calls).toHaveLength(0);
    expect(h.paymentService.settleCalls).toHaveLength(0);
  });

  it('returns stop for a non-kaspi provider', async () => {
    const h = makeHarness();
    h.paymentRepo.payment = makePayment({ provider: 'mock' });
    const r = await h.service.pollOnce(KG, PAYMENT_ID);
    expect(r.outcome).toBe('stop');
  });

  it('reschedules without polling when provider_txn_id is missing', async () => {
    const h = makeHarness();
    h.paymentRepo.payment = makePayment({ providerTxnId: null });
    const r = await h.service.pollOnce(KG, PAYMENT_ID);
    expect(r.outcome).toBe('reschedule');
    expect(h.provider.calls).toHaveLength(0);
  });

  it('settles completed on processed', async () => {
    const h = makeHarness();
    h.paymentRepo.payment = makePayment();
    h.provider.canned = {
      kind: 'processed',
      rawStatus: 'Processed',
      expireDate: null,
    };
    const r = await h.service.pollOnce(KG, PAYMENT_ID);
    expect(r.outcome).toBe('settled');
    expect(h.paymentService.settleCalls).toHaveLength(1);
    expect(h.paymentService.settleCalls[0].terminal.status).toBe('completed');
    expect(h.paymentService.settleCalls[0].terminal.providerPaymentId).toBe(
      QR_OP,
    );
    expect(h.sessionRepo.touchCalls).toBe(1);
  });

  it('settles failed on a terminal status', async () => {
    const h = makeHarness();
    h.paymentRepo.payment = makePayment();
    h.provider.canned = {
      kind: 'terminal',
      rawStatus: 'Canceled',
      expireDate: null,
    };
    const r = await h.service.pollOnce(KG, PAYMENT_ID);
    expect(r.outcome).toBe('failed');
    expect(h.paymentService.settleCalls).toHaveLength(1);
    expect(h.paymentService.settleCalls[0].terminal.status).toBe('failed');
    expect(h.paymentService.settleCalls[0].terminal.failureReason).toBe(
      'kaspi_Canceled',
    );
  });

  it('refreshes and reschedules on session_expired (refresh success)', async () => {
    const h = makeHarness();
    h.paymentRepo.payment = makePayment();
    h.kaspiConnect.shouldThrow = false;
    h.provider.canned = {
      kind: 'session_expired',
      rawStatus: null,
      expireDate: null,
    };
    const r = await h.service.pollOnce(KG, PAYMENT_ID);
    expect(r.outcome).toBe('reschedule');
    expect(h.kaspiConnect.refreshCalls).toBe(1);
    expect(h.notifier.sessionExpiredCalls).toHaveLength(0);
    expect(h.paymentService.settleCalls).toHaveLength(0);
  });

  it('notifies admins and reschedules on session_expired (refresh throws)', async () => {
    const h = makeHarness();
    h.paymentRepo.payment = makePayment();
    h.kaspiConnect.shouldThrow = true;
    h.staffRepo.admins = [{ userId: 'admin-1' }, { userId: 'admin-2' }];
    h.provider.canned = {
      kind: 'session_expired',
      rawStatus: null,
      expireDate: null,
    };
    const r = await h.service.pollOnce(KG, PAYMENT_ID);
    expect(r.outcome).toBe('reschedule');
    expect(h.kaspiConnect.refreshCalls).toBe(1);
    expect(h.notifier.sessionExpiredCalls).toHaveLength(1);
    expect(h.notifier.sessionExpiredCalls[0].recipientUserIds).toEqual([
      'admin-1',
      'admin-2',
    ]);
    // payment stays processing — no settlement
    expect(h.paymentService.settleCalls).toHaveLength(0);
  });

  it('de-dups admin user ids in the session_expired notification', async () => {
    const h = makeHarness();
    h.paymentRepo.payment = makePayment();
    h.kaspiConnect.shouldThrow = true;
    h.staffRepo.admins = [{ userId: 'admin-1' }, { userId: 'admin-1' }];
    h.provider.canned = {
      kind: 'session_expired',
      rawStatus: null,
      expireDate: null,
    };
    await h.service.pollOnce(KG, PAYMENT_ID);
    expect(h.notifier.sessionExpiredCalls[0].recipientUserIds).toEqual([
      'admin-1',
    ]);
  });

  it('does not notify when refresh throws but there are no admins', async () => {
    const h = makeHarness();
    h.paymentRepo.payment = makePayment();
    h.kaspiConnect.shouldThrow = true;
    h.staffRepo.admins = [];
    h.provider.canned = {
      kind: 'session_expired',
      rawStatus: null,
      expireDate: null,
    };
    const r = await h.service.pollOnce(KG, PAYMENT_ID);
    expect(r.outcome).toBe('reschedule');
    expect(h.notifier.sessionExpiredCalls).toHaveLength(0);
  });

  it('settles failed on session_expired past the ExpireDate', async () => {
    const h = makeHarness();
    h.paymentRepo.payment = makePayment();
    h.kaspiConnect.shouldThrow = false;
    h.provider.canned = {
      kind: 'session_expired',
      rawStatus: null,
      expireDate: new Date(NOW.getTime() - 1_000),
    };
    const r = await h.service.pollOnce(KG, PAYMENT_ID);
    expect(r.outcome).toBe('failed');
    expect(h.kaspiConnect.refreshCalls).toBe(1);
    expect(h.paymentService.settleCalls).toHaveLength(1);
    expect(h.paymentService.settleCalls[0].terminal.status).toBe('failed');
    expect(h.paymentService.settleCalls[0].terminal.failureReason).toBe(
      'kaspi_expired',
    );
  });

  it('reschedules on session_expired with a future ExpireDate', async () => {
    const h = makeHarness();
    h.paymentRepo.payment = makePayment();
    h.kaspiConnect.shouldThrow = false;
    h.provider.canned = {
      kind: 'session_expired',
      rawStatus: null,
      expireDate: new Date(NOW.getTime() + 60_000),
    };
    const r = await h.service.pollOnce(KG, PAYMENT_ID);
    expect(r.outcome).toBe('reschedule');
    expect(h.paymentService.settleCalls).toHaveLength(0);
  });

  it('reschedules on pending before the ExpireDate', async () => {
    const h = makeHarness();
    h.paymentRepo.payment = makePayment();
    h.provider.canned = {
      kind: 'pending',
      rawStatus: 'RemotePaymentCreated',
      expireDate: new Date(NOW.getTime() + 60_000),
    };
    const r = await h.service.pollOnce(KG, PAYMENT_ID);
    expect(r.outcome).toBe('reschedule');
    expect(h.paymentService.settleCalls).toHaveLength(0);
  });

  it('settles failed on pending past the ExpireDate', async () => {
    const h = makeHarness();
    h.paymentRepo.payment = makePayment();
    h.provider.canned = {
      kind: 'pending',
      rawStatus: 'RemotePaymentCreated',
      expireDate: new Date(NOW.getTime() - 1_000),
    };
    const r = await h.service.pollOnce(KG, PAYMENT_ID);
    expect(r.outcome).toBe('failed');
    expect(h.paymentService.settleCalls).toHaveLength(1);
    expect(h.paymentService.settleCalls[0].terminal.failureReason).toBe(
      'kaspi_expired',
    );
  });

  it('settles failed via hard-cap without calling Kaspi', async () => {
    const h = makeHarness();
    h.paymentRepo.payment = makePayment({
      createdAt: new Date(NOW.getTime() - KASPI_POLL_HARD_CAP_MS - 1_000),
    });
    const r = await h.service.pollOnce(KG, PAYMENT_ID);
    expect(r.outcome).toBe('failed');
    expect(h.provider.calls).toHaveLength(0);
    expect(h.paymentService.settleCalls).toHaveLength(1);
    expect(h.paymentService.settleCalls[0].terminal.failureReason).toBe(
      'kaspi_expired_hard_cap',
    );
  });

  it('reschedules when the Kaspi status fetch throws (network / not-connected)', async () => {
    const h = makeHarness();
    h.paymentRepo.payment = makePayment();
    h.provider.throwErr = new Error('kaspi_http_failed: ECONNRESET');
    const r = await h.service.pollOnce(KG, PAYMENT_ID);
    expect(r.outcome).toBe('reschedule');
    expect(h.paymentService.settleCalls).toHaveLength(0);
    // touch is best-effort and only after a successful fetch — not called here
    expect(h.sessionRepo.touchCalls).toBe(0);
  });
});
