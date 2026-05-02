import { QrToken } from '../../../../domain/entities/qr-token.entity';
import { UserQrTokenTypeOrmEntity } from '../entities/user-qr-token.typeorm.entity';

/**
 * Domain ↔ persistence mapper for the QrToken aggregate. Lives in the
 * relational subtree because it knows the TypeORM-entity shape; the
 * domain/application layers do not.
 */
export class QrTokenMapper {
  static toDomain(entity: UserQrTokenTypeOrmEntity): QrToken {
    return QrToken.fromState({
      id: entity.id,
      userId: entity.user_id,
      kindergartenId: entity.kindergarten_id,
      purpose: entity.purpose,
      tokenHash: entity.token_hash,
      issuedAt: entity.issued_at,
      expiresAt: entity.expires_at,
      revokedAt: entity.revoked_at,
      lastScannedAt: entity.last_scanned_at,
    });
  }

  static toPersistence(domain: QrToken): UserQrTokenTypeOrmEntity {
    const e = new UserQrTokenTypeOrmEntity();
    e.id = domain.id;
    e.user_id = domain.userId;
    e.kindergarten_id = domain.kindergartenId;
    e.purpose = domain.purpose;
    e.token_hash = domain.tokenHash;
    e.issued_at = domain.issuedAt;
    e.expires_at = domain.expiresAt;
    e.revoked_at = domain.revokedAt;
    e.last_scanned_at = domain.lastScannedAt;
    return e;
  }
}
