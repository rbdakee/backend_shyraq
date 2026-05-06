import { ConflictError } from '@/shared-kernel/domain/errors';

/**
 * 409 — caller attempted to cancel or otherwise mutate an invoice that has
 * already reached the terminal `paid` status. Use a refund flow instead.
 */
export class InvoiceAlreadyPaidError extends ConflictError {
  public readonly code = 'invoice_already_paid' as const;

  constructor(invoiceId: string) {
    super('invoice_already_paid', `invoice already paid: ${invoiceId}`);
  }
}
