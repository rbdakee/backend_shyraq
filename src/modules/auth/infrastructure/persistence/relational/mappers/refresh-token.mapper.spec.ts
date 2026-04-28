import { RefreshToken } from '../../../../domain/entities/refresh-token.entity';
import { RefreshTokenEntity } from '../entities/refresh-token.entity';
import { RefreshTokenMapper } from './refresh-token.mapper';

describe('RefreshTokenMapper', () => {
  const expiresAt = new Date('2030-01-01T00:00:00Z');

  function buildEntity(
    overrides: Partial<RefreshTokenEntity> = {},
  ): RefreshTokenEntity {
    const e = new RefreshTokenEntity();
    e.id = 'rt-1';
    e.user_id = 'user-1';
    e.kindergarten_id = 'kg-1';
    e.token_hash = 'hash-abc';
    e.device_id = 'device-1';
    e.ip_address = '127.0.0.1';
    e.expires_at = expiresAt;
    e.revoked_at = null;
    e.created_at = new Date('2024-01-01T00:00:00Z');
    return Object.assign(e, overrides);
  }

  it('toDomain reconstructs RefreshToken aggregate', () => {
    const domain = RefreshTokenMapper.toDomain(buildEntity());
    expect(domain).toBeInstanceOf(RefreshToken);
    expect(domain.id).toBe('rt-1');
    expect(domain.userId).toBe('user-1');
    expect(domain.kindergartenId).toBe('kg-1');
    expect(domain.tokenHash).toBe('hash-abc');
    expect(domain.expiresAt).toEqual(expiresAt);
    expect(domain.revokedAt).toBeNull();
    expect(domain.isActive(new Date('2025-01-01T00:00:00Z'))).toBe(true);
  });

  it('toDomain handles revoked token', () => {
    const revokedAt = new Date('2024-06-01T00:00:00Z');
    const domain = RefreshTokenMapper.toDomain(
      buildEntity({ revoked_at: revokedAt }),
    );
    expect(domain.revokedAt).toEqual(revokedAt);
    expect(domain.isActive(new Date('2025-01-01T00:00:00Z'))).toBe(false);
  });

  it('toDomain handles null kindergarten_id (pre-role-select issue)', () => {
    const domain = RefreshTokenMapper.toDomain(
      buildEntity({ kindergarten_id: null }),
    );
    expect(domain.kindergartenId).toBeNull();
  });

  it('toPersistence round-trips with toDomain', () => {
    const entity = buildEntity();
    const domain = RefreshTokenMapper.toDomain(entity);
    const back = RefreshTokenMapper.toPersistence(domain);
    expect(back.id).toBe(entity.id);
    expect(back.user_id).toBe(entity.user_id);
    expect(back.kindergarten_id).toBe(entity.kindergarten_id);
    expect(back.token_hash).toBe(entity.token_hash);
    expect(back.expires_at).toEqual(entity.expires_at);
    expect(back.revoked_at).toBeNull();
  });
});
