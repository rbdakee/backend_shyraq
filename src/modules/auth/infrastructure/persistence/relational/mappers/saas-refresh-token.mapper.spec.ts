import { SaasRefreshToken } from '../../../../domain/entities/saas-refresh-token.entity';
import { SaasRefreshTokenEntity } from '../entities/saas-refresh-token.entity';
import { SaasRefreshTokenMapper } from './saas-refresh-token.mapper';

describe('SaasRefreshTokenMapper', () => {
  function buildEntity(
    overrides: Partial<SaasRefreshTokenEntity> = {},
  ): SaasRefreshTokenEntity {
    const e = new SaasRefreshTokenEntity();
    e.id = 'srt-1';
    e.saas_user_id = 'saas-user-1';
    e.token_hash = 'hash-xyz';
    e.device_id = null;
    e.ip_address = null;
    e.expires_at = new Date('2030-01-01T00:00:00Z');
    e.revoked_at = null;
    e.created_at = new Date('2024-01-01T00:00:00Z');
    return Object.assign(e, overrides);
  }

  it('toDomain reconstructs SaasRefreshToken', () => {
    const domain = SaasRefreshTokenMapper.toDomain(buildEntity());
    expect(domain).toBeInstanceOf(SaasRefreshToken);
    expect(domain.id).toBe('srt-1');
    expect(domain.saasUserId).toBe('saas-user-1');
    expect(domain.tokenHash).toBe('hash-xyz');
    expect(domain.revokedAt).toBeNull();
  });

  it('toPersistence round-trips fields', () => {
    const entity = buildEntity();
    const domain = SaasRefreshTokenMapper.toDomain(entity);
    const back = SaasRefreshTokenMapper.toPersistence(domain);
    expect(back.id).toBe(entity.id);
    expect(back.saas_user_id).toBe(entity.saas_user_id);
    expect(back.token_hash).toBe(entity.token_hash);
    expect(back.expires_at).toEqual(entity.expires_at);
  });
});
