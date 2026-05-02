import { TrustedPersonRevokedError } from '../errors/trusted-person-revoked.error';
import { TrustedPerson } from './trusted-person.entity';

describe('TrustedPerson (domain)', () => {
  const createdAt = new Date('2026-05-01T10:00:00Z');
  const validInput = {
    id: '00000000-0000-4000-8000-000000000001',
    kindergartenId: '11111111-1111-4000-8000-000000000001',
    childId: '22222222-2222-4000-8000-000000000001',
    addedByUserId: '33333333-3333-4000-8000-000000000001',
    fullName: 'Айгерим Тестова',
    phone: '+77011234567',
    iin: null as string | null,
    relation: 'aunt',
    photoUrl: null as string | null,
    isOneTime: false,
    createdAt,
  };

  it('creates with isActive=true, no usedAt, no revokedAt', () => {
    const tp = TrustedPerson.create(validInput);
    expect(tp.isActive).toBe(true);
    expect(tp.usedAt).toBeNull();
    expect(tp.revokedAt).toBeNull();
    expect(tp.isOneTime).toBe(false);
    expect(tp.fullName).toBe('Айгерим Тестова');
  });

  it('creates as one-time when isOneTime=true', () => {
    const tp = TrustedPerson.create({ ...validInput, isOneTime: true });
    expect(tp.isOneTime).toBe(true);
    expect(tp.isActive).toBe(true);
  });

  it('isAvailableForPickup returns true on a fresh row', () => {
    const tp = TrustedPerson.create(validInput);
    expect(tp.isAvailableForPickup()).toBe(true);
  });

  it('isAvailableForPickup returns false when revoked', () => {
    const tp = TrustedPerson.create(validInput).revoke(
      new Date('2026-05-02T10:00:00Z'),
    );
    expect(tp.isAvailableForPickup()).toBe(false);
  });

  it('isAvailableForPickup returns false on a one-time row that has been used', () => {
    const tp = TrustedPerson.create({
      ...validInput,
      isOneTime: true,
    }).markUsed(new Date('2026-05-02T08:00:00Z'));
    expect(tp.isAvailableForPickup()).toBe(false);
  });

  it('isAvailableForPickup stays true after a non-one-time row is used', () => {
    const tp = TrustedPerson.create(validInput).markUsed(
      new Date('2026-05-02T08:00:00Z'),
    );
    expect(tp.isAvailableForPickup()).toBe(true);
  });

  it('revoke stamps revokedAt + isActive=false and returns a new instance', () => {
    const fresh = TrustedPerson.create(validInput);
    const now = new Date('2026-05-02T10:00:00Z');
    const revoked = fresh.revoke(now);
    expect(revoked).not.toBe(fresh);
    expect(revoked.revokedAt).toBe(now);
    expect(revoked.isActive).toBe(false);
    expect(fresh.revokedAt).toBeNull();
    expect(fresh.isActive).toBe(true);
  });

  it('revoke throws TrustedPersonRevokedError when already revoked', () => {
    const first = TrustedPerson.create(validInput).revoke(
      new Date('2026-05-02T10:00:00Z'),
    );
    expect(() => first.revoke(new Date('2026-05-02T11:00:00Z'))).toThrow(
      TrustedPersonRevokedError,
    );
  });

  it('revoke throws TrustedPersonRevokedError when row is already inactive (e.g. one-time used)', () => {
    const used = TrustedPerson.create({
      ...validInput,
      isOneTime: true,
    }).markUsed(new Date('2026-05-02T08:00:00Z'));
    expect(used.isActive).toBe(false);
    expect(() => used.revoke(new Date('2026-05-02T09:00:00Z'))).toThrow(
      TrustedPersonRevokedError,
    );
  });

  it('markUsed stamps usedAt and returns a new instance', () => {
    const fresh = TrustedPerson.create(validInput);
    const now = new Date('2026-05-02T08:00:00Z');
    const used = fresh.markUsed(now);
    expect(used).not.toBe(fresh);
    expect(used.usedAt).toBe(now);
    expect(fresh.usedAt).toBeNull();
  });

  it('markUsed auto-deactivates a one-time row', () => {
    const fresh = TrustedPerson.create({ ...validInput, isOneTime: true });
    const used = fresh.markUsed(new Date('2026-05-02T08:00:00Z'));
    expect(used.isActive).toBe(false);
    expect(fresh.isActive).toBe(true);
  });

  it('markUsed leaves a non-one-time row active', () => {
    const fresh = TrustedPerson.create(validInput);
    const used = fresh.markUsed(new Date('2026-05-02T08:00:00Z'));
    expect(used.isActive).toBe(true);
  });

  it('toState round-trips via fromState', () => {
    const original = TrustedPerson.create(validInput).markUsed(
      new Date('2026-05-02T08:00:00Z'),
    );
    const rebuilt = TrustedPerson.fromState(original.toState());
    expect(rebuilt.toState()).toEqual(original.toState());
  });
});
