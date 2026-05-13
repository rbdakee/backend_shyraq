import { Refund } from './domain/entities/refund.entity';
import { RefundResponseDto, RefundListResponseDto } from './dto/refund.dto';

/**
 * Domain → response-DTO mapper for Refund.
 * Pure (no Nest / TypeORM imports).
 */
export const RefundPresenter = {
  one(refund: Refund): RefundResponseDto {
    const s = refund.toState();
    return {
      id: s.id,
      kindergarten_id: s.kindergartenId,
      payment_id: s.paymentId,
      invoice_id: s.invoiceId,
      amount: s.amount.toNumber(),
      reason: s.reason,
      status: s.status,
      processed_by: s.processedBy,
      provider_ref: s.providerRef,
      created_at: s.createdAt.toISOString(),
      updated_at: s.updatedAt.toISOString(),
    };
  },

  list(refunds: Refund[], nextCursor: string | null): RefundListResponseDto {
    return {
      items: refunds.map((r) => RefundPresenter.one(r)),
      next_cursor: nextCursor,
    };
  },
};
