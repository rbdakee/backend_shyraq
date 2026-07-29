import { InvariantViolationError } from '@/shared-kernel/domain/errors';

/**
 * 400 — the child has outstanding non-prepayment debt (a `pending`,
 * `overdue` or `partial` monthly/fee invoice), so creating a prepayment is
 * blocked until every such invoice is settled (handoff §2.2). Unpaid
 * `prepayment_*` invoices are NOT debt — a retry cancels the old pending
 * prepayment instead. `outstanding_amount` is the KZT sum of
 * `amount_after_discount − completed_paid` across the blocking invoices.
 */
export class PrepaymentBlockedOutstandingDebtError extends InvariantViolationError {
  public readonly details: { outstanding_amount: number };

  constructor(outstandingAmount: number) {
    super('prepayment_blocked_outstanding_debt');
    this.details = { outstanding_amount: outstandingAmount };
  }
}
