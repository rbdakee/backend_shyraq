import { SaasRefreshToken } from './saas-refresh-token.entity';

describe('SaasRefreshToken (domain)', () => {
  const base = {
    id: 'srt-1',
    saasUserId: 'sa-1',
    tokenHash: 'h'.repeat(64),
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null as Date | null,
  };

  it('isActive=true for fresh un-revoked token', () => {
    expect(SaasRefreshToken.hydrate(base).isActive(new Date())).toBe(true);
  });

  it('isActive=false once expired', () => {
    const t = SaasRefreshToken.hydrate({
      ...base,
      expiresAt: new Date(Date.now() - 1),
    });
    expect(t.isActive(new Date())).toBe(false);
  });

  it('revoke() flips the flag; idempotent', () => {
    const t = SaasRefreshToken.hydrate(base);
    const now = new Date();
    t.revoke(now);
    t.revoke(new Date(Date.now() + 1000));
    expect(t.revokedAt).toBe(now);
    expect(t.isActive(new Date())).toBe(false);
  });
});
