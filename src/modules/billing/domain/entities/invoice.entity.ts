import { InvoiceAlreadyPaidError } from '../errors/invoice-already-paid.error';
import { InvoiceStatusInvalidError } from '../errors/invoice-status-invalid.error';

export type InvoiceType =
  | 'monthly'
  | 'prepayment_3m'
  | 'prepayment_6m'
  | 'prepayment_12m'
  | 'prepayment_24m'
  | 'additional_service'
  | 'late_pickup_fee'
  | 'other';

export type InvoiceStatus =
  | 'pending'
  | 'partial'
  | 'paid'
  | 'overdue'
  | 'refunded'
  | 'cancelled';

export interface InvoiceState {
  id: string;
  kindergartenId: string;
  childId: string;
  paymentAccountId: string;
  tariffPlanId: string | null;
  invoiceType: InvoiceType;
  periodStart: Date;
  periodEnd: Date;
  amountDue: number;
  discountPct: number | null;
  discountReason: string | null;
  amountAfterDiscount: number;
  status: InvoiceStatus;
  dueDate: Date;
  description: string | null;
  proratedForDays: number | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Invoice aggregate (B13). Owns the state machine
 *
 *   pending ──applyPayment(>0,<full)──► partial
 *   pending ──applyPayment(>=full)──► paid
 *   pending ──markOverdue(now>due)──► overdue
 *   pending ──cancel──► cancelled
 *   partial ──applyPayment(>=full)──► paid
 *   partial ──cancel──► cancelled
 *   paid    ──applyRefund(==full)──► refunded
 *   overdue ──applyPayment──► partial | paid
 *   overdue ──cancel──► cancelled
 *
 * `cancelled` and `refunded` are terminal — no further transitions.
 *
 * Money is held as plain `number` (KZT, 2 decimal places). Service /
 * mapper layer is responsible for rounding to two places before persisting
 * — see `computeAmountAfterDiscount` for the canonical rounding helper.
 */
export class Invoice {
  private constructor(private state: InvoiceState) {}

  static fromState(s: InvoiceState): Invoice {
    return new Invoice({ ...s });
  }

  toState(): InvoiceState {
    return { ...this.state };
  }

  // ── getters ────────────────────────────────────────────────────────────

  get id(): string {
    return this.state.id;
  }

  get kindergartenId(): string {
    return this.state.kindergartenId;
  }

  get childId(): string {
    return this.state.childId;
  }

  get paymentAccountId(): string {
    return this.state.paymentAccountId;
  }

  get tariffPlanId(): string | null {
    return this.state.tariffPlanId;
  }

  get invoiceType(): InvoiceType {
    return this.state.invoiceType;
  }

  get periodStart(): Date {
    return this.state.periodStart;
  }

  get periodEnd(): Date {
    return this.state.periodEnd;
  }

  get amountDue(): number {
    return this.state.amountDue;
  }

  get discountPct(): number | null {
    return this.state.discountPct;
  }

  get discountReason(): string | null {
    return this.state.discountReason;
  }

  get amountAfterDiscount(): number {
    return this.state.amountAfterDiscount;
  }

  get status(): InvoiceStatus {
    return this.state.status;
  }

  get dueDate(): Date {
    return this.state.dueDate;
  }

  get description(): string | null {
    return this.state.description;
  }

  get proratedForDays(): number | null {
    return this.state.proratedForDays;
  }

  get createdAt(): Date {
    return this.state.createdAt;
  }

  get updatedAt(): Date {
    return this.state.updatedAt;
  }

  // ── predicates ─────────────────────────────────────────────────────────

  isTerminal(): boolean {
    return (
      this.state.status === 'cancelled' || this.state.status === 'refunded'
    );
  }

  isPaid(): boolean {
    return this.state.status === 'paid';
  }

  // ── transitions ────────────────────────────────────────────────────────

  /**
   * Recomputes `status` from the running paid sum. The caller is expected
   * to compute `currentPaidSum` as the total of all completed payments
   * targeting this invoice (including the new one being applied).
   *
   * `currentPaidSum >= amountAfterDiscount` → `paid`
   * `currentPaidSum > 0`                    → `partial`
   * else                                    → status unchanged
   */
  applyPayment(currentPaidSum: number, now: Date): void {
    if (this.isTerminal()) {
      throw new InvoiceStatusInvalidError(this.state.status, 'applyPayment');
    }
    if (currentPaidSum < 0) {
      throw new InvoiceStatusInvalidError(this.state.status, 'applyPayment');
    }
    if (currentPaidSum >= this.state.amountAfterDiscount) {
      this.state.status = 'paid';
    } else if (currentPaidSum > 0) {
      this.state.status = 'partial';
    }
    this.state.updatedAt = now;
  }

  /**
   * Marks a still-pending invoice as `overdue` once the due date has
   * passed. Aging tag only — does not block subsequent payments.
   */
  markOverdue(now: Date): void {
    if (this.state.status !== 'pending') {
      throw new InvoiceStatusInvalidError(this.state.status, 'markOverdue');
    }
    if (now.getTime() <= this.state.dueDate.getTime()) {
      throw new InvoiceStatusInvalidError(this.state.status, 'markOverdue');
    }
    this.state.status = 'overdue';
    this.state.updatedAt = now;
  }

  /**
   * Cancels the invoice. Allowed only from non-terminal, non-paid states.
   * `paid` invoices must go through the refund flow. `refunded` and
   * `cancelled` are terminal — calling `cancel` on them is a no-op error.
   */
  cancel(now: Date): void {
    if (this.state.status === 'paid') {
      throw new InvoiceAlreadyPaidError(this.state.id);
    }
    if (
      this.state.status !== 'pending' &&
      this.state.status !== 'partial' &&
      this.state.status !== 'overdue'
    ) {
      throw new InvoiceStatusInvalidError(this.state.status, 'cancel');
    }
    this.state.status = 'cancelled';
    this.state.updatedAt = now;
  }

  /**
   * Apply a refund. This phase only supports a full-refund flip — partial
   * refunds will be revisited in B16+ once `Refund.amount < invoice.total`
   * scenarios are formally supported. Allowed source states: `paid`,
   * `partial`. The caller (refund.service) verifies that `refundedAmount`
   * matches the original net total before invoking.
   */
  applyRefund(refundedAmount: number, now: Date): void {
    if (this.state.status !== 'paid' && this.state.status !== 'partial') {
      throw new InvoiceStatusInvalidError(this.state.status, 'applyRefund');
    }
    if (refundedAmount < this.state.amountAfterDiscount) {
      // partial refund support is deferred — see method docstring
      throw new InvoiceStatusInvalidError(this.state.status, 'applyRefund');
    }
    this.state.status = 'refunded';
    this.state.updatedAt = now;
  }

  // ── pure helper ────────────────────────────────────────────────────────

  /**
   * Canonical formula for `amount_after_discount`. Returned value is
   * rounded to 2 decimal places. `null` or `0` discountPct returns
   * `amountDue` unchanged.
   */
  static computeAmountAfterDiscount(
    amountDue: number,
    discountPct: number | null,
  ): number {
    if (discountPct === null || discountPct === 0) {
      return amountDue;
    }
    const raw = (amountDue * (100 - discountPct)) / 100;
    return Math.round(raw * 100) / 100;
  }
}
