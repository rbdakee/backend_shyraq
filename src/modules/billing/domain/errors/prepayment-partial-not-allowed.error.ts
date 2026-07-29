import { InvariantViolationError } from '@/shared-kernel/domain/errors';

/**
 * 400 — a `prepayment_*` invoice was asked to take a PARTIAL payment.
 *
 * Prepayment is an all-at-once product, not a payment plan: the tariff's
 * `prepay_{N}m_pct` discount is granted precisely because the parent settles
 * 3/6/12/24 months in ONE go. Splitting it would hand out the bulk discount
 * for a part-payment and — worse — strand real money on a half-paid
 * prepayment that a retry can never auto-cancel
 * (`prepayment_blocked_partial_prepayment`, which stays as the backstop for
 * an under-settling provider).
 *
 * Partial payments remain fully supported on MONTHLY invoices: 150 000 ₸ can
 * be paid 50k + 70k + 30k across the month without going overdue.
 *
 * Enforced at both money seams — `PaymentService.initiate` (gateway) and
 * `InvoiceService.manualMarkPaid` (admin cash receipt).
 */
export class PrepaymentPartialNotAllowedError extends InvariantViolationError {
  public readonly details: {
    invoice_id: string;
    invoice_type: string;
    amount_due: number;
  };

  constructor(invoiceId: string, invoiceType: string, amountDue: number) {
    super('prepayment_partial_not_allowed');
    this.details = {
      invoice_id: invoiceId,
      invoice_type: invoiceType,
      amount_due: amountDue,
    };
  }
}
