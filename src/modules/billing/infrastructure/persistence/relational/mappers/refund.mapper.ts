import { Refund, RefundState } from '../../../../domain/entities/refund.entity';
import { RefundTypeOrmEntity } from '../entities/refund.typeorm.entity';

/**
 * Domain ↔ TypeORM mapper for `refunds`. T4a creates the happy-path mapping
 * for `forFeature(...)` wiring; T5b will exercise it from `refund.service`.
 */
export class RefundMapper {
  static toDomain(row: RefundTypeOrmEntity): Refund {
    const state: RefundState = {
      id: row.id,
      kindergartenId: row.kindergartenId,
      paymentId: row.paymentId,
      invoiceId: row.invoiceId,
      // Transformer hands `MoneyKzt` directly — pass through.
      amount: row.amount,
      reason: row.reason,
      status: row.status,
      processedBy: row.processedBy,
      providerRef: row.providerRef,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    return Refund.fromState(state);
  }
}
