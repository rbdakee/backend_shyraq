import { InvariantViolationError } from '@/shared-kernel/domain/errors';
import { StaffMember } from './staff-member.entity';

function freshStaff(): StaffMember {
  const now = new Date('2026-04-28T10:00:00.000Z');
  return StaffMember.hydrate({
    id: 'staff-1',
    kindergartenId: 'kg-1',
    userId: 'u-1',
    fullName: 'Айша Нурланова',
    phone: '+77011112233',
    role: 'admin',
    specialistType: null,
    isActive: true,
    hiredAt: now,
    firedAt: null,
    archivedAt: null,
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
        fullName: null,
        phone: null,

        role: 'janitor' as any,
        specialistType: null,
        isActive: true,
        hiredAt: null,
        firedAt: null,
        archivedAt: null,
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

  describe('validateRoleMatrix (directory is the code authority)', () => {
    it('role=specialist requires a non-empty code (any string — no static whitelist)', () => {
      expect(() => StaffMember.validateRoleMatrix('specialist', null)).toThrow(
        InvariantViolationError,
      );
      expect(() => StaffMember.validateRoleMatrix('specialist', '   ')).toThrow(
        InvariantViolationError,
      );
      // a brand-new custom code passes the domain matrix — validity is the
      // service/directory's job, not the domain's.
      expect(() =>
        StaffMember.validateRoleMatrix('specialist', 'doctor_nutritionist'),
      ).not.toThrow();
      expect(() =>
        StaffMember.validateRoleMatrix('specialist', 'brand_new_code'),
      ).not.toThrow();
    });

    it('non-specialist roles forbid a specialist_type', () => {
      expect(() =>
        StaffMember.validateRoleMatrix('mentor', 'psychologist'),
      ).toThrow(InvariantViolationError);
      expect(() =>
        StaffMember.validateRoleMatrix('mentor', null),
      ).not.toThrow();
    });
  });
});
