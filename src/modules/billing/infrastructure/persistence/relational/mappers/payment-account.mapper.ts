import {
  PaymentAccount,
  PaymentAccountState,
} from '../../../../domain/entities/payment-account.entity';
import { PaymentAccountTypeOrmEntity } from '../entities/payment-account.typeorm.entity';

export class PaymentAccountMapper {
  static toDomain(row: PaymentAccountTypeOrmEntity): PaymentAccount {
    const state: PaymentAccountState = {
      id: row.id,
      kindergartenId: row.kindergartenId,
      childId: row.childId,
      // Transformer hands `MoneyKzt` directly — pass through.
      balance: row.balance,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    return PaymentAccount.fromState(state);
  }
}
