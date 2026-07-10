import { InvariantViolationError } from '@/shared-kernel/domain/errors';
import { Kindergarten } from './kindergarten.entity';
import { KindergartenArchivedError } from '../errors/kindergarten-archived.error';

function freshKg(): Kindergarten {
  const now = new Date('2026-04-28T10:00:00.000Z');
  return Kindergarten.hydrate({
    id: 'kg-1',
    name: 'Sunshine',
    slug: 'sunshine',
    address: null,
    phone: null,
    logoUrl: null,
    plan: 'standard',
    settings: {},
    isActive: true,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  });
}

describe('Kindergarten domain', () => {
  it('archive() sets archivedAt + isActive=false; restore() reverses it', () => {
    const kg = freshKg();
    const t1 = new Date('2026-04-29T10:00:00.000Z');
    kg.archive(t1);
    expect(kg.isArchived).toBe(true);
    expect(kg.isActive).toBe(false);
    expect(kg.archivedAt).toEqual(t1);

    const t2 = new Date('2026-04-30T10:00:00.000Z');
    kg.restore(t2);
    expect(kg.isArchived).toBe(false);
    expect(kg.isActive).toBe(true);
    expect(kg.archivedAt).toBeNull();
  });

  it('archive() is idempotent — re-archiving leaves the original timestamp intact', () => {
    const kg = freshKg();
    const t1 = new Date('2026-04-29T10:00:00.000Z');
    kg.archive(t1);
    kg.archive(new Date('2026-05-01T10:00:00.000Z'));
    expect(kg.archivedAt).toEqual(t1);
  });

  it('updateSettings() throws KindergartenArchivedError on archived kg', () => {
    const kg = freshKg();
    kg.archive(new Date());
    expect(() => kg.updateSettings({ tz: 'Asia/Almaty' }, new Date())).toThrow(
      KindergartenArchivedError,
    );
  });

  it('updateSettings() rejects non-objects with InvariantViolationError', () => {
    const kg = freshKg();
    expect(() => kg.updateSettings([] as any, new Date())).toThrow(
      InvariantViolationError,
    );
  });

  it('setLogo() sets and clears the logo URL, bumping updatedAt', () => {
    const kg = freshKg();
    const t1 = new Date('2026-05-02T10:00:00.000Z');
    kg.setLogo('/api/v1/media/kg-1/2026-05/abc.png', t1);
    expect(kg.logoUrl).toBe('/api/v1/media/kg-1/2026-05/abc.png');
    expect(kg.updatedAt).toEqual(t1);

    const t2 = new Date('2026-05-03T10:00:00.000Z');
    kg.setLogo(null, t2);
    expect(kg.logoUrl).toBeNull();
    expect(kg.updatedAt).toEqual(t2);
  });

  it('setLogo() throws KindergartenArchivedError on archived kg', () => {
    const kg = freshKg();
    kg.archive(new Date());
    expect(() => kg.setLogo('/api/v1/media/x.png', new Date())).toThrow(
      KindergartenArchivedError,
    );
  });

  it('toState()/hydrate round-trips logoUrl', () => {
    const kg = freshKg();
    kg.setLogo('/api/v1/media/kg-1/2026-05/abc.png', new Date());
    const state = kg.toState();
    expect(state.logoUrl).toBe('/api/v1/media/kg-1/2026-05/abc.png');
    expect(Kindergarten.hydrate(state).logoUrl).toBe(state.logoUrl);
  });
});
