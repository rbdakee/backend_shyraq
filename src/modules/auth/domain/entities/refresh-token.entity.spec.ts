import { RefreshToken } from './refresh-token.entity';

describe('RefreshToken (domain)', () => {
  const base = {
    id: 'rt-1',
    userId: 'u-1',
    kindergartenId: null as string | null,
    tokenHash: 'h'.repeat(64),
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null as Date | null,
  };

  it('isActive=true for a fresh un-revoked token', () => {
    const t = RefreshToken.hydrate(base);
    expect(t.isActive(new Date())).toBe(true);
  });

  it('isActive=false once expired', () => {
    const t = RefreshToken.hydrate({
      ...base,
      expiresAt: new Date(Date.now() - 1000),
    });
    expect(t.isActive(new Date())).toBe(false);
  });

  it('isActive=false once revoked', () => {
    const t = RefreshToken.hydrate({ ...base, revokedAt: new Date() });
    expect(t.isActive(new Date())).toBe(false);
  });

  it('revoke() sets revokedAt and flips isActive', () => {
    const t = RefreshToken.hydrate(base);
    const now = new Date();
    t.revoke(now);
    expect(t.revokedAt).toBe(now);
    expect(t.isActive(new Date())).toBe(false);
  });

  it('revoke() is idempotent', () => {
    const t = RefreshToken.hydrate(base);
    const first = new Date('2026-01-01T00:00:00Z');
    const second = new Date('2026-01-02T00:00:00Z');
    t.revoke(first);
    t.revoke(second);
    expect(t.revokedAt).toBe(first);
  });
});
