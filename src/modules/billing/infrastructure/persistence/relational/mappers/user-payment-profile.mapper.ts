import {
  UserPaymentProfile,
  UserPaymentProfileState,
} from '../../../../domain/entities/user-payment-profile.entity';
import { UserPaymentProfileTypeOrmEntity } from '../entities/user-payment-profile.typeorm.entity';

export class UserPaymentProfileMapper {
  static toDomain(row: UserPaymentProfileTypeOrmEntity): UserPaymentProfile {
    const state: UserPaymentProfileState = {
      userId: row.userId,
      billingPhone: row.billingPhone,
      billingAddress: row.billingAddress,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    return UserPaymentProfile.fromState(state);
  }
}
