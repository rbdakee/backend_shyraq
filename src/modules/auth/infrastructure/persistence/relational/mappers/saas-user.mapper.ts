import { SaasUser } from '../../../../domain/entities/saas-user.entity';
import { SaasUserEntity } from '../entities/saas-user.entity';

export class SaasUserMapper {
  static toDomain(row: SaasUserEntity): SaasUser {
    return SaasUser.hydrate({
      id: row.id,
      email: row.email,
      phone: row.phone,
      fullName: row.full_name,
      passwordHash: row.password_hash,
      role: row.role,
      isActive: row.is_active,
      lastLoginAt: row.last_login_at,
    });
  }
}
