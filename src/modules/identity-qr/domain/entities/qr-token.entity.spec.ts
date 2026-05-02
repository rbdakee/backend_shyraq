import { QrToken } from './qr-token.entity';

describe('QrToken (domain)', () => {
  const issuedAt = new Date('2026-05-01T00:00:00Z');
  const expiresAt = new Date('2026-05-02T00:00:00Z'); // +24h
  const validHash = 'a'.repeat(64);

  const validInput = {
    id: '00000000-0000-4000-8000-000000000001',
    userId: '00000000-0000-4000-8000-000000000010',
    kindergartenId: null as string | null,
    purpose: 'identity' as const,
    tokenHash: validHash,
    issuedAt,
    expiresAt,
  };

  it('creates with valid input', () => {
    const t = QrToken.create(validInput);
    expect(t.id).toBe(validInput.id);
    expect(t.userId).toBe(validInput.userId);
    expect(t.tokenHash).toBe(validHash);
    expect(t.issuedAt).toBe(issuedAt);
    expect(t.expiresAt).toBe(expiresAt);
    expect(t.revokedAt).toBeNull();
    expect(t.lastScannedAt).toBeNull();
  });

  it('rejects expiresAt equal to issuedAt', () => {
    expect(() =>
      QrToken.create({ ...validInput, expiresAt: issuedAt }),
    ).toThrow(/expiresAt must be after issuedAt/);
  });

  it('rejects expiresAt before issuedAt', () => {
    expect(() =>
      QrToken.create({
        ...validInput,
        expiresAt: new Date(issuedAt.getTime() - 1),
      }),
    ).toThrow(/expiresAt must be after issuedAt/);
  });

  it('rejects malformed tokenHash (uppercase)', () => {
    expect(() =>
      QrToken.create({ ...validInput, tokenHash: 'A'.repeat(64) }),
    ).toThrow(/64 lowercase hex chars/);
  });

  it('rejects malformed tokenHash (wrong length)', () => {
    expect(() =>
      QrToken.create({ ...validInput, tokenHash: 'a'.repeat(63) }),
    ).toThrow(/64 lowercase hex chars/);
    expect(() =>
      QrToken.create({ ...validInput, tokenHash: 'a'.repeat(65) }),
    ).toThrow(/64 lowercase hex chars/);
  });

  it('rejects malformed tokenHash (non-hex characters)', () => {
    expect(() =>
      QrToken.create({ ...validInput, tokenHash: 'g'.repeat(64) }),
    ).toThrow(/64 lowercase hex chars/);
  });

  it('isExpired returns true when now equals expiresAt', () => {
    const t = QrToken.create(validInput);
    expect(t.isExpired(expiresAt)).toBe(true);
  });

  it('isExpired returns true when now is past expiresAt', () => {
    const t = QrToken.create(validInput);
    expect(t.isExpired(new Date(expiresAt.getTime() + 1))).toBe(true);
  });

  it('isExpired returns false when now is before expiresAt', () => {
    const t = QrToken.create(validInput);
    expect(t.isExpired(new Date(expiresAt.getTime() - 1))).toBe(false);
  });

  it('isRevoked reflects revokedAt presence', () => {
    const fresh = QrToken.create(validInput);
    expect(fresh.isRevoked()).toBe(false);
    const revoked = fresh.revoke(new Date('2026-05-01T05:00:00Z'));
    expect(revoked.isRevoked()).toBe(true);
  });

  it('isActive returns false when revoked', () => {
    const t = QrToken.create(validInput).revoke(
      new Date('2026-05-01T05:00:00Z'),
    );
    expect(t.isActive(new Date('2026-05-01T06:00:00Z'))).toBe(false);
  });

  it('isActive returns false when expired', () => {
    const t = QrToken.create(validInput);
    expect(t.isActive(expiresAt)).toBe(false);
  });

  it('isActive returns true when fresh and not revoked', () => {
    const t = QrToken.create(validInput);
    expect(t.isActive(new Date('2026-05-01T12:00:00Z'))).toBe(true);
  });

  it('shouldRefresh returns true when within threshold of expiry', () => {
    const t = QrToken.create(validInput);
    // 30 minutes before expiry, threshold = 1h
    const now = new Date(expiresAt.getTime() - 30 * 60 * 1000);
    expect(t.shouldRefresh(now, 60 * 60 * 1000)).toBe(true);
  });

  it('shouldRefresh returns false when far from expiry', () => {
    const t = QrToken.create(validInput);
    // 23h before expiry, threshold = 1h
    const now = new Date(expiresAt.getTime() - 23 * 60 * 60 * 1000);
    expect(t.shouldRefresh(now, 60 * 60 * 1000)).toBe(false);
  });

  it('shouldRefresh returns true when revoked', () => {
    const t = QrToken.create(validInput).revoke(
      new Date('2026-05-01T05:00:00Z'),
    );
    expect(
      t.shouldRefresh(new Date('2026-05-01T06:00:00Z'), 60 * 60 * 1000),
    ).toBe(true);
  });

  it('shouldRefresh returns true when expired', () => {
    const t = QrToken.create(validInput);
    expect(t.shouldRefresh(expiresAt, 60 * 60 * 1000)).toBe(true);
  });

  it('revoke stamps revokedAt and returns a new instance', () => {
    const fresh = QrToken.create(validInput);
    const now = new Date('2026-05-01T05:00:00Z');
    const revoked = fresh.revoke(now);
    expect(revoked).not.toBe(fresh);
    expect(revoked.revokedAt).toBe(now);
    expect(fresh.revokedAt).toBeNull();
  });

  it('revoke throws when already revoked', () => {
    const first = QrToken.create(validInput).revoke(
      new Date('2026-05-01T05:00:00Z'),
    );
    expect(() => first.revoke(new Date('2026-05-01T06:00:00Z'))).toThrow(
      /already revoked/,
    );
  });

  it('recordScan stamps lastScannedAt and returns a new instance', () => {
    const fresh = QrToken.create(validInput);
    const now = new Date('2026-05-01T08:00:00Z');
    const scanned = fresh.recordScan(now);
    expect(scanned).not.toBe(fresh);
    expect(scanned.lastScannedAt).toBe(now);
    expect(fresh.lastScannedAt).toBeNull();
  });

  it('toState round-trips via fromState', () => {
    const original = QrToken.create(validInput).recordScan(
      new Date('2026-05-01T08:00:00Z'),
    );
    const rebuilt = QrToken.fromState(original.toState());
    expect(rebuilt.toState()).toEqual(original.toState());
  });
});
