import {
  SaasRefreshToken,
  SaasRefreshTokenState,
} from '../../../../domain/entities/saas-refresh-token.entity';
import { SaasRefreshTokenEntity } from '../entities/saas-refresh-token.entity';

export class SaasRefreshTokenMapper {
  static toDomain(entity: SaasRefreshTokenEntity): SaasRefreshToken {
    return SaasRefreshToken.hydrate({
      id: entity.id,
      saasUserId: entity.saas_user_id,
      tokenHash: entity.token_hash,
      expiresAt: entity.expires_at,
      revokedAt: entity.revoked_at,
    });
  }

  static toPersistence(domain: SaasRefreshToken): SaasRefreshTokenEntity {
    const e = new SaasRefreshTokenEntity();
    e.id = domain.id;
    e.saas_user_id = domain.saasUserId;
    e.token_hash = domain.tokenHash;
    e.expires_at = domain.expiresAt;
    e.revoked_at = domain.revokedAt;
    return e;
  }

  static stateToPersistence(
    state: SaasRefreshTokenState,
  ): SaasRefreshTokenEntity {
    const e = new SaasRefreshTokenEntity();
    e.id = state.id;
    e.saas_user_id = state.saasUserId;
    e.token_hash = state.tokenHash;
    e.expires_at = state.expiresAt;
    e.revoked_at = state.revokedAt;
    return e;
  }
}
