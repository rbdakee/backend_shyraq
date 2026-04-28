import { InvariantViolationError } from '@/shared-kernel/domain/errors';
import { StaffMember } from './staff-member.entity';

function freshStaff(): StaffMember {
  const now = new Date('2026-04-28T10:00:00.000Z');
  return StaffMember.hydrate({
    id: 'staff-1',
    kindergartenId: 'kg-1',
    userId: 'u-1',
    role: 'admin',
    specialistType: null,
    isActive: true,
    hiredAt: now,
    firedAt: null,
    createdAt: now,
    updatedAt: now,
  });
}

describe('StaffMember domain', () => {
  it('hydrate rejects unknown role with InvariantViolationError', () => {
    expect(() =>
      StaffMember.hydrate({
        id: 's',
        kindergartenId: 'kg',
        userId: 'u',

        role: 'janitor' as any,
        specialistType: null,
        isActive: true,
        hiredAt: null,
        firedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).toThrow(InvariantViolationError);
  });

  it('deactivate flips isActive + sets firedAt; idempotent', () => {
    const s = freshStaff();
    const t = new Date('2026-04-29T10:00:00.000Z');
    s.deactivate(t);
    expect(s.isActive).toBe(false);
    expect(s.firedAt).toEqual(t);
    s.deactivate(new Date('2026-05-01'));
    expect(s.firedAt).toEqual(t);
  });

  it('activate clears firedAt; idempotent', () => {
    const s = freshStaff();
    s.deactivate(new Date('2026-04-29T10:00:00.000Z'));
    s.activate(new Date('2026-05-01T10:00:00.000Z'));
    expect(s.isActive).toBe(true);
    expect(s.firedAt).toBeNull();
  });
});
