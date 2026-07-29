import { EntityManager } from 'typeorm';
import { InvoiceLineItem } from '../../domain/entities/invoice-line-item.entity';

/**
 * Persistence port for `invoice_line_items`. Used by `InvoiceService` and
 * (later) by the parent invoice presenter to load detail rows when
 * rendering an invoice for the parent app.
 */
export abstract class InvoiceLineItemRepository {
  /**
   * Bulk INSERT of line items. Caller may pass an explicit `manager` to
   * piggy-back on a known TX (e.g. cron worker); otherwise the impl resolves
   * one from `tenantStorage`.
   */
  abstract createMany(
    items: InvoiceLineItem[],
    manager?: EntityManager,
  ): Promise<InvoiceLineItem[]>;

  abstract listByInvoice(
    kindergartenId: string,
    invoiceId: string,
  ): Promise<InvoiceLineItem[]>;

  /**
   * Batch variant of `listByInvoice` — one query for N invoices (payment
   * calendar's paid-prepayment coverage spread, P6). Ordered by
   * `invoice_id, created_at ASC` so per-invoice line items keep the same
   * index→month mapping as `listByInvoice`.
   *
   * Default stub so older in-memory fakes compile; relational overrides.
   */
  listByInvoiceIds(
    _kindergartenId: string,
    _invoiceIds: string[],
  ): Promise<InvoiceLineItem[]> {
    return Promise.resolve([]);
  }
}
