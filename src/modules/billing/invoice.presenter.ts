import { Invoice } from './domain/entities/invoice.entity';
import { InvoiceLineItem } from './domain/entities/invoice-line-item.entity';
import {
  InvoiceResponseDto,
  InvoiceLineItemResponseDto,
  ListInvoicesResponseDto,
} from './dto/invoice.dto';

/**
 * Domain → response-DTO mapper for Invoice and InvoiceLineItem.
 * Pure (no Nest / TypeORM imports).
 */
export const InvoicePresenter = {
  lineItem(item: InvoiceLineItem): InvoiceLineItemResponseDto {
    const s = item.toState();
    return {
      id: s.id,
      invoice_id: s.invoiceId,
      kindergarten_id: s.kindergartenId,
      description: s.description,
      tariff_plan_id: s.tariffPlanId,
      quantity: s.quantity,
      unit_price: s.unitPrice.toNumber(),
      line_total: s.lineTotal.toNumber(),
      created_at: s.createdAt.toISOString(),
    };
  },

  one(invoice: Invoice, lineItems?: InvoiceLineItem[]): InvoiceResponseDto {
    const s = invoice.toState();
    const dto: InvoiceResponseDto = {
      id: s.id,
      kindergarten_id: s.kindergartenId,
      child_id: s.childId,
      payment_account_id: s.paymentAccountId,
      tariff_plan_id: s.tariffPlanId,
      invoice_type: s.invoiceType,
      period_start: toIsoDate(s.periodStart),
      period_end: toIsoDate(s.periodEnd),
      amount_due: s.amountDue.toNumber(),
      discount_pct: s.discountPct,
      discount_reason: s.discountReason,
      amount_after_discount: s.amountAfterDiscount.toNumber(),
      status: s.status,
      due_date: toIsoDate(s.dueDate),
      description: s.description,
      prorated_for_days: s.proratedForDays,
      created_at: s.createdAt.toISOString(),
      updated_at: s.updatedAt.toISOString(),
    };
    if (lineItems !== undefined) {
      dto.line_items = lineItems.map((li) => InvoicePresenter.lineItem(li));
    }
    return dto;
  },

  list(
    invoices: Invoice[],
    nextCursor: string | null,
  ): ListInvoicesResponseDto {
    return {
      items: invoices.map((inv) => InvoicePresenter.one(inv)),
      next_cursor: nextCursor,
    };
  },
};

function toIsoDate(d: Date): string {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
