import { MoneyKzt } from '@/shared-kernel/domain/money-kzt';
import { Refund, RefundState } from './refund.entity';
import { RefundAlreadyProcessedError } from '../errors/refund-already-processed.error';

const NOW = new Date('2026-05-07T10:00:00Z');
const LATER = new Date('2026-05-07T11:00:00Z');
const STAFF_ID = 'staff-uuid-0001';
const PROVIDER_REF = 'mock_refund_ref_001';

function makePending(overrides: Partial<RefundState> = {}): Refund {
  return Refund.fromState({
    id: 'refund-uuid-0001',
    kindergartenId: 'kg-uuid-0001',
    paymentId: 'pay-uuid-0001',
    invoiceId: 'inv-uuid-0001',
    amount: MoneyKzt.fromKzt(100_000),
    reason: 'parent requested',
    status: 'pending',
    processedBy: null,
    providerRef: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

describe('Refund domain entity', () => {
  // ── approve ────────────────────────────────────────────────────────────

  describe('approve', () => {
    it('transitions pending to approved and stamps processedBy', () => {
      const r = makePending();
      r.approve(STAFF_ID, LATER);
      expect(r.status).toBe('approved');
      expect(r.processedBy).toBe(STAFF_ID);
      expect(r.updatedAt).toBe(LATER);
    });

    it('throws RefundAlreadyProcessedError when status is approved', () => {
      const r = makePending({ status: 'approved' });
      expect(() => r.approve(STAFF_ID, LATER)).toThrow(
        RefundAlreadyProcessedError,
      );
    });

    it('throws RefundAlreadyProcessedError when status is processed', () => {
      const r = makePending({ status: 'processed' });
      expect(() => r.approve(STAFF_ID, LATER)).toThrow(
        RefundAlreadyProcessedError,
      );
    });

    it('throws RefundAlreadyProcessedError when status is rejected', () => {
      const r = makePending({ status: 'rejected' });
      expect(() => r.approve(STAFF_ID, LATER)).toThrow(
        RefundAlreadyProcessedError,
      );
    });
  });

  // ── reject ─────────────────────────────────────────────────────────────

  describe('reject', () => {
    it('transitions pending to rejected and overwrites reason', () => {
      const r = makePending();
      r.reject('insufficient evidence', LATER);
      expect(r.status).toBe('rejected');
      expect(r.reason).toBe('insufficient evidence');
      expect(r.updatedAt).toBe(LATER);
    });

    it('throws RefundAlreadyProcessedError when status is approved', () => {
      const r = makePending({ status: 'approved' });
      expect(() => r.reject('reason', LATER)).toThrow(
        RefundAlreadyProcessedError,
      );
    });

    it('throws RefundAlreadyProcessedError when status is processed', () => {
      const r = makePending({ status: 'processed' });
      expect(() => r.reject('reason', LATER)).toThrow(
        RefundAlreadyProcessedError,
      );
    });

    it('throws RefundAlreadyProcessedError when status is rejected', () => {
      const r = makePending({ status: 'rejected' });
      expect(() => r.reject('reason', LATER)).toThrow(
        RefundAlreadyProcessedError,
      );
    });
  });

  // ── process ────────────────────────────────────────────────────────────

  describe('process', () => {
    it('transitions approved to processed and stamps providerRef', () => {
      const r = makePending({ status: 'approved', processedBy: STAFF_ID });
      r.process(PROVIDER_REF, LATER);
      expect(r.status).toBe('processed');
      expect(r.providerRef).toBe(PROVIDER_REF);
      expect(r.updatedAt).toBe(LATER);
    });

    it('accepts a null providerRef (cash refund or pending receipt)', () => {
      const r = makePending({ status: 'approved', processedBy: STAFF_ID });
      r.process(null, LATER);
      expect(r.status).toBe('processed');
      expect(r.providerRef).toBeNull();
    });

    it('throws RefundAlreadyProcessedError when status is pending', () => {
      const r = makePending();
      expect(() => r.process(PROVIDER_REF, LATER)).toThrow(
        RefundAlreadyProcessedError,
      );
    });

    it('throws RefundAlreadyProcessedError when status is processed', () => {
      const r = makePending({ status: 'processed' });
      expect(() => r.process(PROVIDER_REF, LATER)).toThrow(
        RefundAlreadyProcessedError,
      );
    });

    it('throws RefundAlreadyProcessedError when status is rejected', () => {
      const r = makePending({ status: 'rejected' });
      expect(() => r.process(PROVIDER_REF, LATER)).toThrow(
        RefundAlreadyProcessedError,
      );
    });
  });

  // ── error details ──────────────────────────────────────────────────────

  it('RefundAlreadyProcessedError carries currentStatus and attemptedAction', () => {
    const r = makePending({ status: 'processed' });
    try {
      r.approve(STAFF_ID, LATER);
      fail('expected error to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RefundAlreadyProcessedError);
      const e = err as RefundAlreadyProcessedError;
      expect(e.details.currentStatus).toBe('processed');
      expect(e.details.attemptedAction).toBe('approve');
      expect(e.code).toBe('refund_already_processed');
    }
  });

  // ── round-trip ──────────────────────────────────────────────────────────

  it('round-trips state through fromState and toState', () => {
    const state: RefundState = {
      id: 'refund-uuid-0009',
      kindergartenId: 'kg-uuid-0009',
      paymentId: 'pay-uuid-0009',
      invoiceId: null,
      amount: MoneyKzt.fromKzt(5_000),
      reason: 'duplicate charge',
      status: 'approved',
      processedBy: STAFF_ID,
      providerRef: null,
      createdAt: NOW,
      updatedAt: LATER,
    };
    const r = Refund.fromState(state);
    expect(r.toState()).toEqual(state);
  });
});
