import {
  Payment,
  PaymentProvider,
  PaymentState,
} from '../../../../domain/entities/payment.entity';
import { PaymentTypeOrmEntity } from '../entities/payment.typeorm.entity';

/**
 * Domain ↔ TypeORM mapper for `payments`. T4a creates the happy-path mapping
 * for `forFeature(...)` wiring; T5a will exercise it from `payment.service`.
 */
export class PaymentMapper {
  static toDomain(row: PaymentTypeOrmEntity): Payment {
    const state: PaymentState = {
      id: row.id,
      kindergartenId: row.kindergartenId,
      invoiceId: row.invoiceId,
      childId: row.childId,
      payerUserId: row.payerUserId,
      // Transformer hands `MoneyKzt` directly — pass through.
      amount: row.amount,
      provider: row.provider as PaymentProvider,
      providerTxnId: row.providerTxnId,
      idempotencyKey: row.idempotencyKey,
      status: row.status,
      providerPayload: row.providerPayload,
      paidAt: row.paidAt,
      refundId: row.refundId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    return Payment.fromState(state);
  }
}
