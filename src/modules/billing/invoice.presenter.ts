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

  /**
   * `paidSum` is the total of completed payments toward this invoice (KZT).
   * Callers resolve it via `InvoiceRepository.getPaidSumForInvoice` (single)
   * or `getPaidSumsForInvoices` (batch, for lists); it defaults to 0 so
   * call sites that never touch payments (e.g. a freshly created invoice)
   * present `amount_paid: 0` / `amount_remaining: <full>` without a query.
   *
   * `amount_remaining` = `max(0, amount_after_discount − amount_paid)`, EXCEPT
   * for the void terminal states (`cancelled` / `refunded`) where it is forced
   * to 0 — a voided/refunded invoice is not a debt. Without this a refunded
   * invoice would report the full balance again (its payment left `completed`,
   * so `paidSum` drops to 0) and a cancelled unpaid invoice would show its full
   * amount as "still owed". Clients rely on `amount_remaining` as "how much is
   * actually owed", so terminal-void → 0.
   */
  one(
    invoice: Invoice,
    lineItems?: InvoiceLineItem[],
    paidSum = 0,
  ): InvoiceResponseDto {
    const s = invoice.toState();
    const afterDiscount = s.amountAfterDiscount.toNumber();
    const amountPaid = paidSum;
    const isVoid = s.status === 'cancelled' || s.status === 'refunded';
    const amountRemaining = isVoid
      ? 0
      : Math.max(0, afterDiscount - amountPaid);
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
      amount_after_discount: afterDiscount,
      amount_paid: amountPaid,
      amount_remaining: amountRemaining,
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
    paidSums?: Map<string, number>,
  ): ListInvoicesResponseDto {
    return {
      items: invoices.map((inv) =>
        InvoicePresenter.one(inv, undefined, paidSums?.get(inv.id) ?? 0),
      ),
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
