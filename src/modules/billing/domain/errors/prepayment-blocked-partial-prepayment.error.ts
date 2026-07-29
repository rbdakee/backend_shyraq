import { InvariantViolationError } from '@/shared-kernel/domain/errors';

/**
 * 400 — the child has a stale `prepayment_*` invoice that already HOLDS
 * parent money (completed-payment sum > 0, whatever its status — `partial`,
 * or `overdue` after the nightly `markOverdueBatch` flipped a partial row).
 * A money-holding prepayment is never auto-cancelled by a retry (review
 * FIX 2): cancelling it would strand the parent's payment inside a
 * cancelled invoice. Creation is blocked until the stale prepayment is
 * settled or manually resolved by an admin.
 */
export class PrepaymentBlockedPartialPrepaymentError extends InvariantViolationError {
  public readonly details: { invoice_id: string; paid_amount: number };

  constructor(invoiceId: string, paidAmount: number) {
    super('prepayment_blocked_partial_prepayment');
    this.details = { invoice_id: invoiceId, paid_amount: paidAmount };
  }
}
