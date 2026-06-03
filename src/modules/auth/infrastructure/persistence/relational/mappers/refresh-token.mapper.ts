import {
  RefreshToken,
  RefreshTokenState,
} from '../../../../domain/entities/refresh-token.entity';
import { RefreshTokenEntity } from '../entities/refresh-token.entity';

export class RefreshTokenMapper {
  static toDomain(entity: RefreshTokenEntity): RefreshToken {
    return RefreshToken.hydrate({
      id: entity.id,
      userId: entity.user_id,
      kindergartenId: entity.kindergarten_id,
      tokenHash: entity.token_hash,
      expiresAt: entity.expires_at,
      revokedAt: entity.revoked_at,
      audience: entity.audience,
    });
  }

  static toPersistence(domain: RefreshToken): RefreshTokenEntity {
    const e = new RefreshTokenEntity();
    e.id = domain.id;
    e.user_id = domain.userId;
    e.kindergarten_id = domain.kindergartenId;
    e.token_hash = domain.tokenHash;
    e.expires_at = domain.expiresAt;
    e.revoked_at = domain.revokedAt;
    e.audience = domain.audience;
    return e;
  }

  static stateToPersistence(state: RefreshTokenState): RefreshTokenEntity {
    const e = new RefreshTokenEntity();
    e.id = state.id;
    e.user_id = state.userId;
    e.kindergarten_id = state.kindergartenId;
    e.token_hash = state.tokenHash;
    e.expires_at = state.expiresAt;
    e.revoked_at = state.revokedAt;
    e.audience = state.audience;
    return e;
  }
}
