import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { MoneyKzt } from '@/shared-kernel/domain/money-kzt';
import { Payment } from './domain/entities/payment.entity';
import { BccPaymentProvider } from './infrastructure/payment-provider/bcc/bcc-payment-provider.adapter';
import { PaymentRepository } from './infrastructure/persistence/payment.repository';
import { PaymentService } from './payment.service';
import { BccReconciliationService } from './bcc-reconciliation.service';

const KG = '00000000-0000-4000-8000-000000000001';
const PAYMENT = '00000000-0000-4000-8000-000000000002';
const ORDER = '1234567890123';
const CREATED = new Date('2026-07-06T00:00:00.000Z');

class FixedClock extends ClockPort {
  constructor(public value: Date) {
    super();
  }
  now(): Date {
    return this.value;
  }
}

class FakeRepo {
  payment: Payment | null = makePayment();
  claim = true;
  rescheduled: Date | null = null;
  manualReview = false;

  findByIdCrossTenant(): Promise<Payment | null> {
    return Promise.resolve(this.payment);
  }
  claimBccReconciliationCrossTenant(): Promise<Payment | null> {
    return Promise.resolve(this.claim ? this.payment : null);
  }
  rescheduleBccReconciliationCrossTenant(
    _kg: string,
    _id: string,
    nextAt: Date,
  ): Promise<boolean> {
    this.rescheduled = nextAt;
    return Promise.resolve(true);
  }
  markBccManualReviewCrossTenant(): Promise<boolean> {
    this.manualReview = true;
    return Promise.resolve(true);
  }
}

class FakeProvider {
  response = {
    httpStatus: 200,
    httpOk: true,
    fields: {},
    diagnostics: {
      action: '0',
      rc: '00',
      rcText: 'Approved',
      order: ORDER,
      rrn: '618721285042',
      intRef: '6D1C6D9B343B89CA',
    },
  };
  getPaymentStatus() {
    return Promise.resolve(this.response);
  }
}

class FakePayments {
  terminals: unknown[] = [];
  settleFromBccReconciliation(
    kindergartenId: string,
    paymentId: string,
    terminal: unknown,
  ): Promise<unknown> {
    this.terminals.push({ kindergartenId, paymentId, terminal });
    return Promise.resolve({ paymentId, status: 'completed' });
  }
}

function makePayment(
  createdAt = CREATED,
  attempts = 1,
  nextAt = new Date('2026-07-06T00:05:00.000Z'),
): Payment {
  return Payment.fromState({
    id: PAYMENT,
    kindergartenId: KG,
    invoiceId: '00000000-0000-4000-8000-000000000003',
    childId: '00000000-0000-4000-8000-000000000004',
    payerUserId: null,
    amount: MoneyKzt.fromKzt(350),
    provider: 'bcc',
    providerTxnId: ORDER,
    idempotencyKey: 'idempotency',
    status: 'processing',
    providerPayload: { transaction_type: '1' },
    paidAt: null,
    refundId: null,
    reconciliationAttempts: attempts,
    lastReconciledAt: null,
    nextReconciliationAt: nextAt,
    manualReviewRequiredAt: null,
    createdAt,
    updatedAt: createdAt,
  });
}

function harness(now = new Date('2026-07-06T00:05:00.000Z')) {
  const repo = new FakeRepo();
  const provider = new FakeProvider();
  const payments = new FakePayments();
  const service = new BccReconciliationService(
    provider as unknown as BccPaymentProvider,
    payments as unknown as PaymentService,
    repo as unknown as PaymentRepository,
    new FixedClock(now),
  );
  return { repo, provider, payments, service };
}

describe('BccReconciliationService', () => {
  it('settles a late ACTION=0/RC=00 through the common payment service', async () => {
    const h = harness();
    await expect(h.service.reconcileOnce(KG, PAYMENT)).resolves.toEqual({
      outcome: 'settled',
      nextAt: null,
    });
    expect(h.payments.terminals).toEqual([
      expect.objectContaining({
        kindergartenId: KG,
        paymentId: PAYMENT,
        terminal: expect.objectContaining({
          providerPaymentId: ORDER,
          status: 'completed',
          raw: expect.objectContaining({
            action: '0',
            rc: '00',
            source: 'bcc_reconciliation',
          }),
        }),
      }),
    ]);
  });

  it('uses bounded backoff for a non-terminal result', async () => {
    const h = harness();
    h.provider.response.diagnostics.action = '22';
    h.provider.response.diagnostics.rc = null as unknown as string;
    const result = await h.service.reconcileOnce(KG, PAYMENT);
    expect(result.outcome).toBe('reschedule');
    expect(result.nextAt).toEqual(h.repo.rescheduled);
    expect(result.nextAt!.getTime()).toBeGreaterThan(
      new Date('2026-07-06T00:05:00.000Z').getTime(),
    );
    expect(h.payments.terminals).toHaveLength(0);
  });

  it('marks manual review at 24 hours without failing the payment', async () => {
    const h = harness(new Date('2026-07-07T00:00:00.000Z'));
    await expect(h.service.reconcileOnce(KG, PAYMENT)).resolves.toEqual({
      outcome: 'manual_review',
      nextAt: null,
    });
    expect(h.repo.manualReview).toBe(true);
    expect(h.payments.terminals).toHaveLength(0);
  });

  it('does not issue a second status request when the atomic claim is lost', async () => {
    const h = harness();
    h.repo.claim = false;
    await expect(h.service.reconcileOnce(KG, PAYMENT)).resolves.toEqual({
      outcome: 'reschedule',
      nextAt: new Date('2026-07-06T00:05:00.000Z'),
    });
    expect(h.payments.terminals).toHaveLength(0);
  });
});
