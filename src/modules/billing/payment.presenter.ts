import { Payment } from './domain/entities/payment.entity';
import { PaymentResponseDto, PaymentListResponseDto } from './dto/payment.dto';

/**
 * Domain → response-DTO mapper for Payment.
 * Pure (no Nest / TypeORM imports).
 *
 * `redirectUrl` and `deeplink` are optional extras returned only on
 * payment initiation — pass them when present, omit otherwise.
 */
export const PaymentPresenter = {
  one(
    payment: Payment,
    extras?: { redirectUrl?: string | null; deeplink?: string | null },
  ): PaymentResponseDto {
    const s = payment.toState();
    const dto: PaymentResponseDto = {
      id: s.id,
      kindergarten_id: s.kindergartenId,
      invoice_id: s.invoiceId,
      child_id: s.childId,
      payer_user_id: s.payerUserId,
      amount: s.amount.toNumber(),
      provider: s.provider,
      provider_txn_id: s.providerTxnId,
      idempotency_key: s.idempotencyKey,
      status: s.status,
      paid_at: s.paidAt ? s.paidAt.toISOString() : null,
      refund_id: s.refundId,
      created_at: s.createdAt.toISOString(),
      updated_at: s.updatedAt.toISOString(),
    };
    if (extras?.redirectUrl !== undefined) {
      dto.redirect_url = extras.redirectUrl;
    }
    if (extras?.deeplink !== undefined) {
      dto.deeplink = extras.deeplink;
    }
    return dto;
  },

  list(payments: Payment[], nextCursor: string | null): PaymentListResponseDto {
    return {
      items: payments.map((p) => PaymentPresenter.one(p)),
      next_cursor: nextCursor,
    };
  },
};
