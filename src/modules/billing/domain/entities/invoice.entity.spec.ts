import { Invoice, InvoiceState } from './invoice.entity';
import { InvoiceAlreadyPaidError } from '../errors/invoice-already-paid.error';
import { InvoiceStatusInvalidError } from '../errors/invoice-status-invalid.error';

const NOW = new Date('2026-05-07T10:00:00Z');
const LATER = new Date('2026-05-07T11:00:00Z');
const PAST_DUE = new Date('2026-06-15T10:00:00Z');

function makePending(overrides: Partial<InvoiceState> = {}): Invoice {
  return Invoice.fromState({
    id: 'inv-uuid-0001',
    kindergartenId: 'kg-uuid-0001',
    childId: 'child-uuid-0001',
    paymentAccountId: 'acct-uuid-0001',
    tariffPlanId: 'tp-uuid-0001',
    invoiceType: 'monthly',
    periodStart: new Date('2026-05-01'),
    periodEnd: new Date('2026-05-31'),
    amountDue: 100_000,
    discountPct: null,
    discountReason: null,
    amountAfterDiscount: 100_000,
    status: 'pending',
    dueDate: new Date('2026-05-31'),
    description: null,
    proratedForDays: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

describe('Invoice domain entity', () => {
  // ── computeAmountAfterDiscount (pure helper) ───────────────────────────

  describe('computeAmountAfterDiscount', () => {
    it('returns amountDue unchanged when discountPct is null', () => {
      expect(Invoice.computeAmountAfterDiscount(100_000, null)).toBe(100_000);
    });

    it('returns amountDue unchanged when discountPct is 0', () => {
      expect(Invoice.computeAmountAfterDiscount(100_000, 0)).toBe(100_000);
    });

    it('applies a 10 percent discount and rounds to two decimals', () => {
      expect(Invoice.computeAmountAfterDiscount(100_000, 10)).toBe(90_000);
    });

    it('rounds half-cent values to nearest cent', () => {
      // 99.999 → 99.99 nope — Math.round((99.999*0.5)*100)/100 → just verify a known case
      expect(Invoice.computeAmountAfterDiscount(99.99, 50)).toBe(50);
    });

    it('handles 100 percent discount as zero', () => {
      expect(Invoice.computeAmountAfterDiscount(100_000, 100)).toBe(0);
    });
  });

  // ── predicates ─────────────────────────────────────────────────────────

  describe('predicates', () => {
    it('returns isTerminal=false for pending', () => {
      expect(makePending().isTerminal()).toBe(false);
    });

    it('returns isTerminal=true for cancelled', () => {
      expect(makePending({ status: 'cancelled' }).isTerminal()).toBe(true);
    });

    it('returns isTerminal=true for refunded', () => {
      expect(makePending({ status: 'refunded' }).isTerminal()).toBe(true);
    });

    it('returns isPaid=true only when status is paid', () => {
      expect(makePending({ status: 'paid' }).isPaid()).toBe(true);
      expect(makePending({ status: 'pending' }).isPaid()).toBe(false);
      expect(makePending({ status: 'partial' }).isPaid()).toBe(false);
    });
  });

  // ── applyPayment ───────────────────────────────────────────────────────

  describe('applyPayment', () => {
    it('transitions pending to paid when sum equals amountAfterDiscount', () => {
      const inv = makePending();
      inv.applyPayment(100_000, LATER);
      expect(inv.status).toBe('paid');
      expect(inv.updatedAt).toBe(LATER);
    });

    it('transitions pending to paid when sum exceeds amountAfterDiscount', () => {
      const inv = makePending();
      inv.applyPayment(150_000, LATER);
      expect(inv.status).toBe('paid');
    });

    it('transitions pending to partial when 0 < sum < amountAfterDiscount', () => {
      const inv = makePending();
      inv.applyPayment(40_000, LATER);
      expect(inv.status).toBe('partial');
      expect(inv.updatedAt).toBe(LATER);
    });

    it('keeps pending when sum is 0', () => {
      const inv = makePending();
      inv.applyPayment(0, LATER);
      expect(inv.status).toBe('pending');
      expect(inv.updatedAt).toBe(LATER);
    });

    it('promotes partial to paid when sum reaches full', () => {
      const inv = makePending({ status: 'partial' });
      inv.applyPayment(100_000, LATER);
      expect(inv.status).toBe('paid');
    });

    it('promotes overdue to paid when sum reaches full', () => {
      const inv = makePending({ status: 'overdue' });
      inv.applyPayment(100_000, LATER);
      expect(inv.status).toBe('paid');
    });

    it('promotes overdue to partial when sum is positive but below full', () => {
      const inv = makePending({ status: 'overdue' });
      inv.applyPayment(40_000, LATER);
      expect(inv.status).toBe('partial');
    });

    it('throws InvoiceStatusInvalidError when status is cancelled', () => {
      const inv = makePending({ status: 'cancelled' });
      expect(() => inv.applyPayment(100_000, LATER)).toThrow(
        InvoiceStatusInvalidError,
      );
    });

    it('throws InvoiceStatusInvalidError when status is refunded', () => {
      const inv = makePending({ status: 'refunded' });
      expect(() => inv.applyPayment(100_000, LATER)).toThrow(
        InvoiceStatusInvalidError,
      );
    });

    it('throws InvoiceStatusInvalidError when currentPaidSum is negative', () => {
      const inv = makePending();
      expect(() => inv.applyPayment(-1, LATER)).toThrow(
        InvoiceStatusInvalidError,
      );
    });
  });

  // ── markOverdue ────────────────────────────────────────────────────────

  describe('markOverdue', () => {
    it('transitions pending to overdue when now > dueDate', () => {
      const inv = makePending();
      inv.markOverdue(PAST_DUE);
      expect(inv.status).toBe('overdue');
      expect(inv.updatedAt).toBe(PAST_DUE);
    });

    it('throws InvoiceStatusInvalidError when now equals dueDate', () => {
      const inv = makePending();
      expect(() => inv.markOverdue(inv.dueDate)).toThrow(
        InvoiceStatusInvalidError,
      );
    });

    it('throws InvoiceStatusInvalidError when now is before dueDate', () => {
      const inv = makePending();
      expect(() => inv.markOverdue(NOW)).toThrow(InvoiceStatusInvalidError);
    });

    it('throws InvoiceStatusInvalidError when status is partial', () => {
      const inv = makePending({ status: 'partial' });
      expect(() => inv.markOverdue(PAST_DUE)).toThrow(
        InvoiceStatusInvalidError,
      );
    });

    it('throws InvoiceStatusInvalidError when status is paid', () => {
      const inv = makePending({ status: 'paid' });
      expect(() => inv.markOverdue(PAST_DUE)).toThrow(
        InvoiceStatusInvalidError,
      );
    });

    it('throws InvoiceStatusInvalidError when status is overdue', () => {
      const inv = makePending({ status: 'overdue' });
      expect(() => inv.markOverdue(PAST_DUE)).toThrow(
        InvoiceStatusInvalidError,
      );
    });
  });

  // ── cancel ─────────────────────────────────────────────────────────────

  describe('cancel', () => {
    it('transitions pending to cancelled', () => {
      const inv = makePending();
      inv.cancel(LATER);
      expect(inv.status).toBe('cancelled');
      expect(inv.updatedAt).toBe(LATER);
    });

    it('transitions partial to cancelled', () => {
      const inv = makePending({ status: 'partial' });
      inv.cancel(LATER);
      expect(inv.status).toBe('cancelled');
    });

    it('transitions overdue to cancelled', () => {
      const inv = makePending({ status: 'overdue' });
      inv.cancel(LATER);
      expect(inv.status).toBe('cancelled');
    });

    it('throws InvoiceAlreadyPaidError when status is paid', () => {
      const inv = makePending({ status: 'paid' });
      expect(() => inv.cancel(LATER)).toThrow(InvoiceAlreadyPaidError);
    });

    it('throws InvoiceStatusInvalidError when status is refunded', () => {
      const inv = makePending({ status: 'refunded' });
      expect(() => inv.cancel(LATER)).toThrow(InvoiceStatusInvalidError);
    });

    it('throws InvoiceStatusInvalidError when status is already cancelled', () => {
      const inv = makePending({ status: 'cancelled' });
      expect(() => inv.cancel(LATER)).toThrow(InvoiceStatusInvalidError);
    });
  });

  // ── applyRefund ────────────────────────────────────────────────────────

  describe('applyRefund', () => {
    it('transitions paid to refunded when refundedAmount equals net total', () => {
      const inv = makePending({ status: 'paid' });
      inv.applyRefund(100_000, LATER);
      expect(inv.status).toBe('refunded');
      expect(inv.updatedAt).toBe(LATER);
    });

    it('transitions paid to refunded when refundedAmount exceeds net total', () => {
      const inv = makePending({ status: 'paid' });
      inv.applyRefund(110_000, LATER);
      expect(inv.status).toBe('refunded');
    });

    it('transitions partial to refunded when refundedAmount equals net total', () => {
      const inv = makePending({ status: 'partial' });
      inv.applyRefund(100_000, LATER);
      expect(inv.status).toBe('refunded');
    });

    it('throws InvoiceStatusInvalidError on partial-amount refund (full-only for now)', () => {
      const inv = makePending({ status: 'paid' });
      expect(() => inv.applyRefund(50_000, LATER)).toThrow(
        InvoiceStatusInvalidError,
      );
    });

    it('throws InvoiceStatusInvalidError when status is pending', () => {
      const inv = makePending({ status: 'pending' });
      expect(() => inv.applyRefund(100_000, LATER)).toThrow(
        InvoiceStatusInvalidError,
      );
    });

    it('throws InvoiceStatusInvalidError when status is cancelled', () => {
      const inv = makePending({ status: 'cancelled' });
      expect(() => inv.applyRefund(100_000, LATER)).toThrow(
        InvoiceStatusInvalidError,
      );
    });

    it('throws InvoiceStatusInvalidError when status is already refunded', () => {
      const inv = makePending({ status: 'refunded' });
      expect(() => inv.applyRefund(100_000, LATER)).toThrow(
        InvoiceStatusInvalidError,
      );
    });
  });

  // ── error details ──────────────────────────────────────────────────────

  it('InvoiceStatusInvalidError carries currentStatus and attemptedAction', () => {
    const inv = makePending({ status: 'cancelled' });
    try {
      inv.applyPayment(100_000, LATER);
      fail('expected error to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(InvoiceStatusInvalidError);
      const e = err as InvoiceStatusInvalidError;
      expect(e.details.currentStatus).toBe('cancelled');
      expect(e.details.attemptedAction).toBe('applyPayment');
      expect(e.code).toBe('invoice_status_invalid');
    }
  });

  // ── round-trip ──────────────────────────────────────────────────────────

  it('round-trips state through fromState and toState', () => {
    const state: InvoiceState = {
      id: 'inv-uuid-0009',
      kindergartenId: 'kg-uuid-0009',
      childId: 'child-uuid-0009',
      paymentAccountId: 'acct-uuid-0009',
      tariffPlanId: null,
      invoiceType: 'late_pickup_fee',
      periodStart: new Date('2026-05-07'),
      periodEnd: new Date('2026-05-07'),
      amountDue: 1_500,
      discountPct: 5,
      discountReason: 'sibling',
      amountAfterDiscount: 1_425,
      status: 'pending',
      dueDate: new Date('2026-05-14'),
      description: 'late pickup 14 minutes',
      proratedForDays: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const inv = Invoice.fromState(state);
    expect(inv.toState()).toEqual(state);
  });
});
