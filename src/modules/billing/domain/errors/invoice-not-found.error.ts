import { NotFoundError } from '@/shared-kernel/domain/errors';

/**
 * 404 — caller asked for an invoice id that is not visible under the
 * caller's tenant scope (or simply does not exist).
 */
export class InvoiceNotFoundError extends NotFoundError {
  public readonly code = 'invoice_not_found' as const;

  constructor(invoiceId: string) {
    super('invoice', invoiceId);
  }
}
