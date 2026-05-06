import { Payment, PaymentState } from './payment.entity';
import { PaymentStatusInvalidError } from '../errors/payment-status-invalid.error';

const NOW = new Date('2026-05-07T10:00:00Z');
const LATER = new Date('2026-05-07T11:00:00Z');
const PROVIDER_TXN = 'mock_txn_abc123';
const REFUND_ID = 'refund-uuid-0001';

function makeInitiated(overrides: Partial<PaymentState> = {}): Payment {
  return Payment.fromState({
    id: 'pay-uuid-0001',
    kindergartenId: 'kg-uuid-0001',
    invoiceId: 'inv-uuid-0001',
    childId: 'child-uuid-0001',
    payerUserId: 'user-uuid-0001',
    amount: 100_000,
    provider: 'mock',
    providerTxnId: null,
    idempotencyKey: 'idem-key-0001',
    status: 'initiated',
    providerPayload: null,
    paidAt: null,
    refundId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

describe('Payment domain entity', () => {
  // ── constructor invariant ──────────────────────────────────────────────

  describe('constructor invariant', () => {
    it('throws when idempotencyKey is empty string', () => {
      expect(() => makeInitiated({ idempotencyKey: '' })).toThrow(
        /idempotencyKey must be a non-empty string/,
      );
    });
  });

  // ── predicates ─────────────────────────────────────────────────────────

  describe('predicates', () => {
    it('returns isCompleted=true only when status is completed', () => {
      expect(makeInitiated({ status: 'completed' }).isCompleted()).toBe(true);
      expect(makeInitiated({ status: 'initiated' }).isCompleted()).toBe(false);
    });

    it('returns isTerminal=true for failed and refunded', () => {
      expect(makeInitiated({ status: 'failed' }).isTerminal()).toBe(true);
      expect(makeInitiated({ status: 'refunded' }).isTerminal()).toBe(true);
      expect(makeInitiated({ status: 'completed' }).isTerminal()).toBe(false);
    });
  });

  // ── markProcessing ─────────────────────────────────────────────────────

  describe('markProcessing', () => {
    it('transitions initiated to processing and updates timestamp', () => {
      const p = makeInitiated();
      p.markProcessing(LATER);
      expect(p.status).toBe('processing');
      expect(p.updatedAt).toBe(LATER);
    });

    it('throws PaymentStatusInvalidError when status is processing', () => {
      const p = makeInitiated({ status: 'processing' });
      expect(() => p.markProcessing(LATER)).toThrow(PaymentStatusInvalidError);
    });

    it('throws PaymentStatusInvalidError when status is completed', () => {
      const p = makeInitiated({ status: 'completed' });
      expect(() => p.markProcessing(LATER)).toThrow(PaymentStatusInvalidError);
    });

    it('throws PaymentStatusInvalidError when status is failed', () => {
      const p = makeInitiated({ status: 'failed' });
      expect(() => p.markProcessing(LATER)).toThrow(PaymentStatusInvalidError);
    });

    it('throws PaymentStatusInvalidError when status is refunded', () => {
      const p = makeInitiated({ status: 'refunded' });
      expect(() => p.markProcessing(LATER)).toThrow(PaymentStatusInvalidError);
    });
  });

  // ── markCompleted ──────────────────────────────────────────────────────

  describe('markCompleted', () => {
    it('transitions initiated directly to completed (synchronous Mock)', () => {
      const p = makeInitiated();
      p.markCompleted(PROVIDER_TXN, LATER);
      expect(p.status).toBe('completed');
      expect(p.providerTxnId).toBe(PROVIDER_TXN);
      expect(p.paidAt).toBe(LATER);
      expect(p.updatedAt).toBe(LATER);
    });

    it('transitions processing to completed (async webhook)', () => {
      const p = makeInitiated({ status: 'processing' });
      p.markCompleted(PROVIDER_TXN, LATER);
      expect(p.status).toBe('completed');
      expect(p.providerTxnId).toBe(PROVIDER_TXN);
    });

    it('throws PaymentStatusInvalidError when status is completed', () => {
      const p = makeInitiated({ status: 'completed' });
      expect(() => p.markCompleted(PROVIDER_TXN, LATER)).toThrow(
        PaymentStatusInvalidError,
      );
    });

    it('throws PaymentStatusInvalidError when status is failed', () => {
      const p = makeInitiated({ status: 'failed' });
      expect(() => p.markCompleted(PROVIDER_TXN, LATER)).toThrow(
        PaymentStatusInvalidError,
      );
    });

    it('throws PaymentStatusInvalidError when status is refunded', () => {
      const p = makeInitiated({ status: 'refunded' });
      expect(() => p.markCompleted(PROVIDER_TXN, LATER)).toThrow(
        PaymentStatusInvalidError,
      );
    });
  });

  // ── markFailed ─────────────────────────────────────────────────────────

  describe('markFailed', () => {
    it('transitions initiated to failed and stamps reason on payload', () => {
      const p = makeInitiated();
      p.markFailed('insufficient_funds', LATER);
      expect(p.status).toBe('failed');
      expect(p.providerPayload).toEqual({
        failure_reason: 'insufficient_funds',
      });
      expect(p.updatedAt).toBe(LATER);
    });

    it('transitions processing to failed', () => {
      const p = makeInitiated({ status: 'processing' });
      p.markFailed('declined', LATER);
      expect(p.status).toBe('failed');
    });

    it('preserves prior providerPayload entries when stamping failure_reason', () => {
      const p = makeInitiated({
        providerPayload: { provider_session: 'sess-001' },
      });
      p.markFailed('timeout', LATER);
      expect(p.providerPayload).toEqual({
        provider_session: 'sess-001',
        failure_reason: 'timeout',
      });
    });

    it('throws PaymentStatusInvalidError when status is completed', () => {
      const p = makeInitiated({ status: 'completed' });
      expect(() => p.markFailed('reason', LATER)).toThrow(
        PaymentStatusInvalidError,
      );
    });

    it('throws PaymentStatusInvalidError when status is failed', () => {
      const p = makeInitiated({ status: 'failed' });
      expect(() => p.markFailed('reason', LATER)).toThrow(
        PaymentStatusInvalidError,
      );
    });

    it('throws PaymentStatusInvalidError when status is refunded', () => {
      const p = makeInitiated({ status: 'refunded' });
      expect(() => p.markFailed('reason', LATER)).toThrow(
        PaymentStatusInvalidError,
      );
    });
  });

  // ── markRefunded ───────────────────────────────────────────────────────

  describe('markRefunded', () => {
    it('transitions completed to refunded and stamps refundId', () => {
      const p = makeInitiated({ status: 'completed' });
      p.markRefunded(REFUND_ID, LATER);
      expect(p.status).toBe('refunded');
      expect(p.refundId).toBe(REFUND_ID);
      expect(p.updatedAt).toBe(LATER);
    });

    it('throws PaymentStatusInvalidError when status is initiated', () => {
      const p = makeInitiated();
      expect(() => p.markRefunded(REFUND_ID, LATER)).toThrow(
        PaymentStatusInvalidError,
      );
    });

    it('throws PaymentStatusInvalidError when status is processing', () => {
      const p = makeInitiated({ status: 'processing' });
      expect(() => p.markRefunded(REFUND_ID, LATER)).toThrow(
        PaymentStatusInvalidError,
      );
    });

    it('throws PaymentStatusInvalidError when status is failed', () => {
      const p = makeInitiated({ status: 'failed' });
      expect(() => p.markRefunded(REFUND_ID, LATER)).toThrow(
        PaymentStatusInvalidError,
      );
    });

    it('throws PaymentStatusInvalidError when status is already refunded', () => {
      const p = makeInitiated({ status: 'refunded' });
      expect(() => p.markRefunded(REFUND_ID, LATER)).toThrow(
        PaymentStatusInvalidError,
      );
    });
  });

  // ── error details ──────────────────────────────────────────────────────

  it('PaymentStatusInvalidError carries currentStatus and attemptedAction', () => {
    const p = makeInitiated({ status: 'failed' });
    try {
      p.markCompleted(PROVIDER_TXN, LATER);
      fail('expected error to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PaymentStatusInvalidError);
      const e = err as PaymentStatusInvalidError;
      expect(e.details.currentStatus).toBe('failed');
      expect(e.details.attemptedAction).toBe('markCompleted');
      expect(e.code).toBe('payment_status_invalid');
    }
  });
});
