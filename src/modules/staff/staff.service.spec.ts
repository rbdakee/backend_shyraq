/**
 * StaffService — service-unit suite. Hand-written in-memory fakes for every
 * port (no Jest auto-mock). Focused on the F10 mentor-cascade fix —
 * deactivate / archive must close every active group_mentors row owned by
 * the staff member, otherwise a deactivated staff still occupies the unique
 * active-mentor slot enforced by `idx_group_mentors_one_active`.
 */
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { InvariantViolationError } from '@/shared-kernel/domain/errors';
import { SpecialistTypeService } from '@/modules/specialist-type/specialist-type.service';
import { SmsPort, SmsSendResult } from '@/modules/auth/sms.port';
import { Group } from '@/modules/group/domain/entities/group.entity';
import { GroupMentor } from '@/modules/group/domain/entities/group-mentor.entity';
import {
  CreateGroupInput,
  GroupRepository,
  ListGroupsFilters,
  UpdateGroupInput,
} from '@/modules/group/infrastructure/persistence/group.repository';
import { User } from '@/modules/users/domain/entities/user.entity';
import {
  UserRepository,
  UserUpdateInput,
} from '@/modules/users/infrastructure/persistence/user.repository';
import { StaffMember } from './domain/entities/staff-member.entity';
import { StaffArchivedError } from './domain/errors/staff-archived.error';
import { StaffNotFoundError } from './domain/errors/staff-not-found.error';
import {
  CreateStaffMemberInput,
  ListStaffFilters,
  StaffMemberRepository,
  UpdateStaffMemberInput,
} from './infrastructure/persistence/staff-member.repository';
import { StaffService } from './staff.service';

// ── Constants ────────────────────────────────────────────────────────────

const KG = '11111111-1111-1111-1111-111111111111';
const NOW = new Date('2026-04-30T10:00:00.000Z');

class FixedClock extends ClockPort {
  constructor(private readonly fixed: Date) {
    super();
  }
  now(): Date {
    return this.fixed;
  }
}

// ── Fakes ────────────────────────────────────────────────────────────────

class FakeStaffRepo extends StaffMemberRepository {
  rows: StaffMember[] = [];
  saveCalls = 0;

  put(sm: StaffMember): void {
    this.rows.push(sm);
  }

  create(input: CreateStaffMemberInput): Promise<StaffMember> {
    const sm = StaffMember.hydrate({
      id: `staff-${this.rows.length + 1}`,
      kindergartenId: input.kindergartenId,
      userId: input.userId,
      fullName: input.fullName ?? null,
      phone: input.phone ?? null,
      role: input.role,
      specialistType: input.specialistType ?? null,
      isActive: true,
      hiredAt: input.hiredAt ?? null,
      firedAt: null,
      archivedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    this.rows.push(sm);
    return Promise.resolve(sm);
  }

  findById(kindergartenId: string, id: string): Promise<StaffMember | null> {
    return Promise.resolve(
      this.rows.find(
        (r) => r.id === id && r.kindergartenId === kindergartenId,
      ) ?? null,
    );
  }

  findActiveByUserAndKindergarten(
    userId: string,
    kindergartenId: string,
  ): Promise<StaffMember | null> {
    return Promise.resolve(
      this.rows.find(
        (r) =>
          r.userId === userId &&
          r.kindergartenId === kindergartenId &&
          r.isActive,
      ) ?? null,
    );
  }

  findByUserAndKindergarten(
    userId: string,
    kindergartenId: string,
  ): Promise<StaffMember | null> {
    const matches = this.rows.filter(
      (r) => r.userId === userId && r.kindergartenId === kindergartenId,
    );
    return Promise.resolve(matches[matches.length - 1] ?? null);
  }

  listByKindergarten(
    kindergartenId: string,
    _filters?: ListStaffFilters,
  ): Promise<StaffMember[]> {
    return Promise.resolve(
      this.rows.filter((r) => r.kindergartenId === kindergartenId),
    );
  }

  update(
    _kg: string,
    _id: string,
    _changes: UpdateStaffMemberInput,
  ): Promise<StaffMember | null> {
    return Promise.resolve(null);
  }

  save(staffMember: StaffMember): Promise<StaffMember> {
    this.saveCalls += 1;
    // The fakes hold the same object reference, so mutations from the
    // service (deactivate/archive) are already visible. Just acknowledge.
    return Promise.resolve(staffMember);
  }

  deactivateAllByKindergarten(
    _kindergartenId: string,
    _now: Date,
  ): Promise<number> {
    return Promise.resolve(0);
  }

  findAllActiveByUserId(userId: string): Promise<StaffMember[]> {
    return Promise.resolve(
      this.rows.filter((r) => r.userId === userId && r.isActive),
    );
  }
}

class FakeUserRepo extends UserRepository {
  private byId = new Map<string, User>();
  private seq = 0;

  findById(id: string): Promise<User | null> {
    return Promise.resolve(this.byId.get(id) ?? null);
  }
  findByPhone(phone: string): Promise<User | null> {
    for (const u of this.byId.values()) {
      if (u.toState().phone === phone) return Promise.resolve(u);
    }
    return Promise.resolve(null);
  }
  upsertByPhone(phone: string): Promise<User> {
    const id = `user-new-${++this.seq}`;
    const user = User.hydrate({
      id,
      phone,
      fullName: '',
      avatarUrl: null,
      iin: null,
      dateOfBirth: null,
      locale: 'ru',
    });
    this.byId.set(id, user);
    return Promise.resolve(user);
  }
  update(id: string, changes: UserUpdateInput): Promise<User> {
    const existing = this.byId.get(id);
    if (!existing) throw new Error(`user ${id} not found`);
    const s = existing.toState();
    const next = User.hydrate({
      ...s,
      fullName: changes.fullName ?? s.fullName,
      locale: changes.locale ?? s.locale,
    });
    this.byId.set(id, next);
    return Promise.resolve(next);
  }
}

class FakeSmsPort extends SmsPort {
  sent: {
    phone: string;
    message?: string;
    kindergartenName?: string;
    childName?: string;
    code?: string;
    kind: 'text' | 'otp' | 'admin_invite' | 'staff_invite' | 'trusted_person';
  }[] = [];
  send(phone: string, message: string): Promise<SmsSendResult> {
    this.sent.push({ phone, message, kind: 'text' });
    return Promise.resolve({ txnId: 'noop' });
  }
  sendOtp(_phone: string, _code: string): Promise<SmsSendResult> {
    return Promise.resolve({ txnId: 'noop-otp' });
  }
  sendAdminInvite(
    phone: string,
    kindergartenName: string,
  ): Promise<SmsSendResult> {
    this.sent.push({ phone, kindergartenName, kind: 'admin_invite' });
    return Promise.resolve({ txnId: 'noop-admin-invite' });
  }
  sendStaffInvite(
    phone: string,
    kindergartenName: string,
  ): Promise<SmsSendResult> {
    this.sent.push({ phone, kindergartenName, kind: 'staff_invite' });
    return Promise.resolve({ txnId: 'noop-staff-invite' });
  }
  sendTrustedPersonAssigned(
    phone: string,
    childName: string,
    kindergartenName: string,
  ): Promise<SmsSendResult> {
    this.sent.push({
      phone,
      childName,
      kindergartenName,
      kind: 'trusted_person',
    });
    return Promise.resolve({ txnId: 'noop-trusted-person' });
  }
  sendPickupOtp(
    phone: string,
    childName: string,
    kindergartenName: string,
    code: string,
  ): Promise<SmsSendResult> {
    this.sent.push({ phone, childName, kindergartenName, code, kind: 'otp' });
    return Promise.resolve({ txnId: 'noop-pickup-otp' });
  }
}

/**
 * Minimal in-memory GroupRepository — only `unassignMentorByStaffMember` is
 * actually exercised by the suite. Other surface area throws so a test that
 * accidentally reaches it fails loudly.
 */
class FakeGroupRepo extends GroupRepository {
  /** Active mentor rows. Mutated by `unassignMentorByStaffMember`. */
  mentors: GroupMentor[] = [];
  /** Captured calls — `[kgId, staffMemberId, now, affected]` per call. */
  cascadeCalls: Array<{
    kgId: string;
    staffMemberId: string;
    now: Date;
    affected: number;
  }> = [];

  putMentor(m: GroupMentor): void {
    this.mentors.push(m);
  }

  create(_kg: string, _input: CreateGroupInput): Promise<Group> {
    throw new Error('not used');
  }
  findById(_kg: string, _id: string): Promise<Group | null> {
    throw new Error('not used');
  }
  list(_kg: string, _filters?: ListGroupsFilters): Promise<Group[]> {
    throw new Error('not used');
  }
  update(
    _kg: string,
    _id: string,
    _patch: UpdateGroupInput,
  ): Promise<Group | null> {
    throw new Error('not used');
  }
  save(_g: Group): Promise<Group> {
    throw new Error('not used');
  }
  assignMentor(
    _kg: string,
    _gid: string,
    _sid: string,
    _now: Date,
  ): Promise<GroupMentor> {
    throw new Error('not used');
  }
  unassignMentor(
    _kg: string,
    _gid: string,
    _now: Date,
  ): Promise<GroupMentor | null> {
    throw new Error('not used');
  }
  unassignMentorByStaffMember(
    kgId: string,
    staffMemberId: string,
    now: Date,
  ): Promise<number> {
    let affected = 0;
    for (const m of this.mentors) {
      if (
        m.kindergartenId === kgId &&
        m.staffMemberId === staffMemberId &&
        m.isActive
      ) {
        m.unassign(now);
        affected += 1;
      }
    }
    this.cascadeCalls.push({ kgId, staffMemberId, now, affected });
    return Promise.resolve(affected);
  }
  findActiveMentor(kg: string, groupId: string): Promise<GroupMentor | null> {
    return Promise.resolve(
      this.mentors.find(
        (m) => m.kindergartenId === kg && m.groupId === groupId && m.isActive,
      ) ?? null,
    );
  }
  listMentorHistory(_kg: string, _gid: string): Promise<GroupMentor[]> {
    throw new Error('not used');
  }
  findActiveMentorAssignmentsByUserIdCrossTenant(
    _userId: string,
  ): Promise<GroupMentor[]> {
    throw new Error('not used');
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

function makeStaff(opts: {
  id: string;
  kg: string;
  isActive?: boolean;
  archived?: boolean;
}): StaffMember {
  return StaffMember.hydrate({
    id: opts.id,
    kindergartenId: opts.kg,
    userId: `user-${opts.id}`,
    fullName: `Staff ${opts.id}`,
    phone: '+77011110000',
    role: 'mentor',
    specialistType: null,
    isActive: opts.isActive ?? true,
    hiredAt: NOW,
    firedAt: null,
    archivedAt: opts.archived ? NOW : null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function makeMentor(opts: {
  id: string;
  kg: string;
  groupId: string;
  staffId: string;
}): GroupMentor {
  return GroupMentor.hydrate({
    id: opts.id,
    kindergartenId: opts.kg,
    groupId: opts.groupId,
    staffMemberId: opts.staffId,
    isPrimary: true,
    assignedAt: NOW,
    unassignedAt: null,
    createdAt: NOW,
  });
}

/**
 * Directory-validator fake. `activeCodes` is the set of codes that
 * `assertUsableCode` accepts; anything else throws
 * `specialist_type_unknown` (400), matching the real service.
 */
class FakeSpecialistTypeService {
  activeCodes = new Set<string>();
  assertUsableCode(_kg: string, code: string): Promise<void> {
    if (!this.activeCodes.has(code)) {
      return Promise.reject(
        new InvariantViolationError('specialist_type_unknown'),
      );
    }
    return Promise.resolve();
  }
}

interface Wired {
  service: StaffService;
  staffRepo: FakeStaffRepo;
  groupRepo: FakeGroupRepo;
  specialistTypes: FakeSpecialistTypeService;
}

function wire(): Wired {
  const staffRepo = new FakeStaffRepo();
  const userRepo = new FakeUserRepo();
  const sms = new FakeSmsPort();
  const clock = new FixedClock(NOW);
  const groupRepo = new FakeGroupRepo();
  const specialistTypes = new FakeSpecialistTypeService();
  const service = new StaffService(
    staffRepo,
    userRepo,
    sms,
    clock,
    groupRepo,
    undefined,
    specialistTypes as unknown as SpecialistTypeService,
  );
  return { service, staffRepo, groupRepo, specialistTypes };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('StaffService — F10 mentor-cascade on lifecycle', () => {
  describe('deactivate', () => {
    it('closes all active group_mentors rows when staff mentors 2 groups', async () => {
      const { service, staffRepo, groupRepo } = wire();
      staffRepo.put(makeStaff({ id: 's1', kg: KG }));
      groupRepo.putMentor(
        makeMentor({ id: 'm1', kg: KG, groupId: 'g1', staffId: 's1' }),
      );
      groupRepo.putMentor(
        makeMentor({ id: 'm2', kg: KG, groupId: 'g2', staffId: 's1' }),
      );

      const result = await service.deactivate(KG, 's1');

      expect(result.isActive).toBe(false);
      expect(result.firedAt).toEqual(NOW);
      // Both mentor rows must be closed (unassigned_at = NOW).
      expect(groupRepo.mentors[0].isActive).toBe(false);
      expect(groupRepo.mentors[0].unassignedAt).toEqual(NOW);
      expect(groupRepo.mentors[1].isActive).toBe(false);
      expect(groupRepo.mentors[1].unassignedAt).toEqual(NOW);
      expect(groupRepo.cascadeCalls).toHaveLength(1);
      expect(groupRepo.cascadeCalls[0]).toMatchObject({
        kgId: KG,
        staffMemberId: 's1',
        affected: 2,
      });
    });

    it('is a no-op when staff is not actively mentoring anywhere', async () => {
      const { service, staffRepo, groupRepo } = wire();
      staffRepo.put(makeStaff({ id: 's1', kg: KG }));

      const result = await service.deactivate(KG, 's1');

      expect(result.isActive).toBe(false);
      expect(groupRepo.cascadeCalls).toHaveLength(1);
      expect(groupRepo.cascadeCalls[0].affected).toBe(0);
    });

    it('does not touch mentor rows owned by OTHER staff', async () => {
      const { service, staffRepo, groupRepo } = wire();
      staffRepo.put(makeStaff({ id: 's1', kg: KG }));
      staffRepo.put(makeStaff({ id: 's2', kg: KG }));
      groupRepo.putMentor(
        makeMentor({ id: 'm1', kg: KG, groupId: 'g1', staffId: 's1' }),
      );
      groupRepo.putMentor(
        makeMentor({ id: 'm2', kg: KG, groupId: 'g2', staffId: 's2' }),
      );

      await service.deactivate(KG, 's1');

      // s1's mentor row closed, s2's untouched.
      expect(groupRepo.mentors[0].isActive).toBe(false);
      expect(groupRepo.mentors[1].isActive).toBe(true);
    });

    it('throws StaffNotFoundError when staff does not exist', async () => {
      const { service } = wire();
      await expect(service.deactivate(KG, 'no-such')).rejects.toBeInstanceOf(
        StaffNotFoundError,
      );
    });

    it('throws StaffArchivedError when staff is already archived', async () => {
      const { service, staffRepo } = wire();
      staffRepo.put(makeStaff({ id: 's1', kg: KG, archived: true }));
      await expect(service.deactivate(KG, 's1')).rejects.toBeInstanceOf(
        StaffArchivedError,
      );
    });

    it('is idempotent on already-inactive staff (no cascade, no save)', async () => {
      const { service, staffRepo, groupRepo } = wire();
      staffRepo.put(makeStaff({ id: 's1', kg: KG, isActive: false }));

      const result = await service.deactivate(KG, 's1');

      expect(result.isActive).toBe(false);
      expect(groupRepo.cascadeCalls).toHaveLength(0);
      expect(staffRepo.saveCalls).toBe(0);
    });
  });

  describe('archive', () => {
    it('closes the active mentor row when archiving a mentoring staff', async () => {
      const { service, staffRepo, groupRepo } = wire();
      staffRepo.put(makeStaff({ id: 's1', kg: KG }));
      groupRepo.putMentor(
        makeMentor({ id: 'm1', kg: KG, groupId: 'g1', staffId: 's1' }),
      );

      const result = await service.archive(KG, 's1');

      expect(result.isArchived).toBe(true);
      expect(result.isActive).toBe(false);
      expect(groupRepo.mentors[0].isActive).toBe(false);
      expect(groupRepo.cascadeCalls).toHaveLength(1);
      expect(groupRepo.cascadeCalls[0].affected).toBe(1);
    });

    it('is idempotent on already-archived staff (no cascade)', async () => {
      const { service, staffRepo, groupRepo } = wire();
      staffRepo.put(makeStaff({ id: 's1', kg: KG, archived: true }));

      const result = await service.archive(KG, 's1');

      expect(result.isArchived).toBe(true);
      expect(groupRepo.cascadeCalls).toHaveLength(0);
    });

    it('is a no-op cascade when archiving a non-mentor', async () => {
      const { service, staffRepo, groupRepo } = wire();
      staffRepo.put(makeStaff({ id: 's1', kg: KG }));

      await service.archive(KG, 's1');

      expect(groupRepo.cascadeCalls).toHaveLength(1);
      expect(groupRepo.cascadeCalls[0].affected).toBe(0);
    });
  });

  describe('activate / restore — no cascade', () => {
    it('activate does not touch group_mentors', async () => {
      const { service, staffRepo, groupRepo } = wire();
      staffRepo.put(makeStaff({ id: 's1', kg: KG, isActive: false }));

      await service.activate(KG, 's1');

      expect(groupRepo.cascadeCalls).toHaveLength(0);
    });

    it('restore does not touch group_mentors', async () => {
      const { service, staffRepo, groupRepo } = wire();
      staffRepo.put(makeStaff({ id: 's1', kg: KG, archived: true }));

      await service.restore(KG, 's1');

      expect(groupRepo.cascadeCalls).toHaveLength(0);
    });
  });

  describe('specialist_type directory validation', () => {
    it('rejects creating a specialist with an unknown code (specialist_type_unknown)', async () => {
      const { service } = wire();
      await expect(
        service.create(KG, {
          fullName: 'Спец',
          phone: '+77010000099',
          role: 'specialist',
          specialistType: 'no_such_code',
        }),
      ).rejects.toMatchObject({ code: 'specialist_type_unknown' });
    });

    it('creates a specialist when the code is active in the directory', async () => {
      const { service, staffRepo, specialistTypes } = wire();
      specialistTypes.activeCodes.add('doctor_nutritionist');
      const created = await service.create(KG, {
        fullName: 'Врач Нутрициолог',
        phone: '+77010000098',
        role: 'specialist',
        specialistType: 'doctor_nutritionist',
      });
      expect(created.specialistType).toBe('doctor_nutritionist');
      expect(staffRepo.rows).toHaveLength(1);
    });
  });
});
