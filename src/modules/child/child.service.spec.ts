import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { NotificationPort } from '@/common/notifications/notification.port';
import { Group } from '@/modules/group/domain/entities/group.entity';
import { GroupNotFoundError } from '@/modules/group/domain/errors/group-not-found.error';
import {
  CreateGroupInput,
  GroupRepository,
  ListGroupsFilters,
  UpdateGroupInput,
} from '@/modules/group/infrastructure/persistence/group.repository';
import { GroupMentor } from '@/modules/group/domain/entities/group-mentor.entity';
import { StaffMember } from '@/modules/staff/domain/entities/staff-member.entity';
import {
  CreateStaffMemberInput,
  ListStaffFilters,
  StaffMemberRepository,
  UpdateStaffMemberInput,
} from '@/modules/staff/infrastructure/persistence/staff-member.repository';
import { User } from '@/modules/users/domain/entities/user.entity';
import {
  UserRepository,
  UserUpdateInput,
} from '@/modules/users/infrastructure/persistence/user.repository';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { ChildGuardianRepository } from './infrastructure/persistence/child-guardian.repository';
import {
  ChildGroupHistoryRecord,
  ChildListFilters,
  ChildRepository,
  PageRequest,
  PageResult,
} from './infrastructure/persistence/child.repository';
import { ChildService } from './child.service';
import { Child } from './domain/entities/child.entity';
import { ChildGuardian } from './domain/entities/child-guardian.entity';
import { AlreadyLinkedToChildError } from './domain/errors/already-linked-to-child.error';
import { AlreadyPendingForChildError } from './domain/errors/already-pending-for-child.error';
import { ChildAccessDeniedError } from './domain/errors/child-access-denied.error';
import { ChildIinAlreadyExistsError } from './domain/errors/child-iin-already-exists.error';
import { ChildNotFoundError } from './domain/errors/child-not-found.error';
import { ChildNotFoundForIinError } from './domain/errors/child-not-found-for-iin.error';
import { DuplicateGuardianError } from './domain/errors/duplicate-guardian.error';
import { GroupTransferToSelfError } from './domain/errors/group-transfer-to-self.error';
import { GuardianNotApprovedError } from './domain/errors/guardian-not-approved.error';
import { GuardianNotFoundError } from './domain/errors/guardian-not-found.error';
import { InvalidGuardianStatusTransitionError } from './domain/errors/invalid-guardian-status-transition.error';
import { MaxApprovalRightsExceededError } from './domain/errors/max-approval-rights-exceeded.error';
import { MultipleChildrenForIinError } from './domain/errors/multiple-children-for-iin.error';
import { NotPrimaryGuardianError } from './domain/errors/not-primary-guardian.error';
import { PrimaryCannotSelfUnlinkError } from './domain/errors/primary-cannot-self-unlink.error';

// ── fakes ─────────────────────────────────────────────────────────────────

class FakeClock implements ClockPort {
  constructor(public fixed: Date = new Date('2026-04-28T12:00:00.000Z')) {}
  now(): Date {
    return this.fixed;
  }
}

class FakeChildRepo extends ChildRepository {
  children = new Map<string, Child>();
  history: ChildGroupHistoryRecord[] = [];

  put(c: Child): void {
    this.children.set(c.id, c);
  }

  create(child: Child): Promise<void> {
    const state = child.toState();
    if (state.iin) {
      const dup = [...this.children.values()].find(
        (c) =>
          c.kindergartenId === state.kindergartenId &&
          c.toState().iin === state.iin &&
          c.id !== state.id,
      );
      if (dup) throw new ChildIinAlreadyExistsError(state.iin);
    }
    this.put(child);
    return Promise.resolve();
  }

  findById(kindergartenId: string, id: string): Promise<Child | null> {
    const c = this.children.get(id);
    if (!c || c.kindergartenId !== kindergartenId) return Promise.resolve(null);
    return Promise.resolve(c);
  }

  findByKindergartenAndIin(
    kindergartenId: string,
    iin: string,
  ): Promise<Child | null> {
    const c = [...this.children.values()].find(
      (x) => x.kindergartenId === kindergartenId && x.toState().iin === iin,
    );
    return Promise.resolve(c ?? null);
  }

  update(child: Child): Promise<void> {
    this.put(child);
    return Promise.resolve();
  }

  list(
    kindergartenId: string,
    filters: ChildListFilters,
    page: PageRequest,
  ): Promise<PageResult<Child>> {
    let items = [...this.children.values()].filter(
      (c) => c.kindergartenId === kindergartenId,
    );
    if (filters.status) {
      items = items.filter((c) => c.status.value === filters.status);
    }
    if (filters.currentGroupId) {
      items = items.filter(
        (c) => c.toState().currentGroupId === filters.currentGroupId,
      );
    }
    if (filters.q) {
      const q = filters.q.toLowerCase();
      items = items.filter((c) => c.fullName.toLowerCase().includes(q));
    }
    return Promise.resolve({
      items: items.slice(page.offset, page.offset + page.limit),
      total: items.length,
    });
  }

  countActiveByGroup(kindergartenId: string, groupId: string): Promise<number> {
    return Promise.resolve(
      [...this.children.values()].filter(
        (c) =>
          c.kindergartenId === kindergartenId &&
          c.toState().currentGroupId === groupId &&
          c.status.value === 'active',
      ).length,
    );
  }

  recordGroupTransfer(
    kindergartenId: string,
    childId: string,
    fromGroupId: string | null,
    toGroupId: string,
    transferredByStaffId: string,
    reason: string | null,
    at: Date,
  ): Promise<void> {
    void kindergartenId;
    this.history.push({
      id: `h-${this.history.length + 1}`,
      childId,
      fromGroupId,
      toGroupId,
      transferredAt: at,
      transferredByStaffId,
      reason,
    });
    return Promise.resolve();
  }

  listGroupHistory(
    kindergartenId: string,
    childId: string,
  ): Promise<ChildGroupHistoryRecord[]> {
    void kindergartenId;
    return Promise.resolve(this.history.filter((h) => h.childId === childId));
  }

  findByIinCrossTenant(iin: string): Promise<Child[]> {
    return Promise.resolve(
      [...this.children.values()].filter(
        (c) => c.toState().iin === iin && c.status.value !== 'archived',
      ),
    );
  }

  findByIdsCrossTenant(ids: string[]): Promise<Child[]> {
    return Promise.resolve(
      [...this.children.values()].filter((c) => ids.includes(c.id)),
    );
  }
}

class FakeGuardianRepo extends ChildGuardianRepository {
  guardians = new Map<string, ChildGuardian>();

  put(g: ChildGuardian): void {
    this.guardians.set(g.id, g);
  }

  create(g: ChildGuardian): Promise<void> {
    this.put(g);
    return Promise.resolve();
  }

  findById(kindergartenId: string, id: string): Promise<ChildGuardian | null> {
    const g = this.guardians.get(id);
    if (!g || g.kindergartenId !== kindergartenId) return Promise.resolve(null);
    return Promise.resolve(g);
  }

  findByChildId(
    kindergartenId: string,
    childId: string,
  ): Promise<ChildGuardian[]> {
    return Promise.resolve(
      [...this.guardians.values()].filter(
        (g) => g.kindergartenId === kindergartenId && g.childId === childId,
      ),
    );
  }

  findActiveByChildAndUser(
    kindergartenId: string,
    childId: string,
    userId: string,
  ): Promise<ChildGuardian | null> {
    const g = [...this.guardians.values()].find(
      (x) =>
        x.kindergartenId === kindergartenId &&
        x.childId === childId &&
        x.userId === userId &&
        x.status.value !== 'revoked',
    );
    return Promise.resolve(g ?? null);
  }

  findApprovedByChildAndUserCrossTenant(
    childId: string,
    userId: string,
  ): Promise<ChildGuardian | null> {
    const g = [...this.guardians.values()].find(
      (x) =>
        x.childId === childId &&
        x.userId === userId &&
        x.status.value === 'approved',
    );
    return Promise.resolve(g ?? null);
  }

  findByIdCrossTenant(guardianId: string): Promise<ChildGuardian | null> {
    return Promise.resolve(this.guardians.get(guardianId) ?? null);
  }

  findPendingForPrimary(
    kindergartenId: string,
    primaryUserId: string,
  ): Promise<ChildGuardian[]> {
    const myChildIds = new Set(
      [...this.guardians.values()]
        .filter(
          (g) =>
            g.kindergartenId === kindergartenId &&
            g.userId === primaryUserId &&
            g.role.value === 'primary' &&
            g.status.value === 'approved',
        )
        .map((g) => g.childId as string),
    );
    return Promise.resolve(
      [...this.guardians.values()].filter(
        (g) =>
          g.kindergartenId === kindergartenId &&
          myChildIds.has(g.childId) &&
          g.status.value === 'pending_approval',
      ),
    );
  }

  update(g: ChildGuardian): Promise<void> {
    this.put(g);
    return Promise.resolve();
  }

  countApprovalRights(
    kindergartenId: string,
    childId: string,
  ): Promise<number> {
    return Promise.resolve(
      [...this.guardians.values()].filter(
        (g) =>
          g.kindergartenId === kindergartenId &&
          g.childId === childId &&
          g.status.value === 'approved' &&
          g.hasApprovalRights,
      ).length,
    );
  }

  listApprovedKindergartenIdsByUserId(userId: string): Promise<string[]> {
    return Promise.resolve(
      Array.from(
        new Set(
          [...this.guardians.values()]
            .filter((g) => g.userId === userId && g.status.value === 'approved')
            .map((g) => g.kindergartenId as string),
        ),
      ),
    );
  }

  findApprovedByUser(
    kindergartenId: string,
    userId: string,
  ): Promise<ChildGuardian[]> {
    return Promise.resolve(
      [...this.guardians.values()].filter(
        (g) =>
          g.kindergartenId === kindergartenId &&
          g.userId === userId &&
          g.status.value === 'approved',
      ),
    );
  }

  findPendingPrimaryByUserIdCrossTenant(
    userId: string,
  ): Promise<ChildGuardian[]> {
    return Promise.resolve(
      [...this.guardians.values()].filter(
        (g) =>
          g.userId === userId &&
          g.role.value === 'primary' &&
          g.status.value === 'pending_approval',
      ),
    );
  }
  findApprovedActivePickupGuardian(
    _kg: string,
    _childId: string,
    _userId: string,
  ): Promise<ChildGuardian | null> {
    return Promise.resolve(null);
  }
  findApprovedActiveByUserIdCrossTenant(
    _userId: string,
  ): Promise<ChildGuardian[]> {
    return Promise.resolve([]);
  }
}

class FakeGroupRepo extends GroupRepository {
  groups = new Map<string, Group>();

  put(g: Group): void {
    this.groups.set(g.id, g);
  }

  create(_kg: string, _input: CreateGroupInput): Promise<Group> {
    return Promise.reject(new Error('not used'));
  }
  findById(kindergartenId: string, id: string): Promise<Group | null> {
    const g = this.groups.get(id);
    if (!g || g.kindergartenId !== kindergartenId) return Promise.resolve(null);
    return Promise.resolve(g);
  }
  list(_kg: string, _filters?: ListGroupsFilters): Promise<Group[]> {
    return Promise.resolve([...this.groups.values()]);
  }
  update(
    _kg: string,
    _id: string,
    _patch: UpdateGroupInput,
  ): Promise<Group | null> {
    return Promise.resolve(null);
  }
  save(g: Group): Promise<Group> {
    this.put(g);
    return Promise.resolve(g);
  }
  assignMentor(): Promise<GroupMentor> {
    return Promise.reject(new Error('not used'));
  }
  unassignMentor(): Promise<GroupMentor | null> {
    return Promise.resolve(null);
  }
  findActiveMentor(): Promise<GroupMentor | null> {
    return Promise.resolve(null);
  }
  listMentorHistory(): Promise<GroupMentor[]> {
    return Promise.resolve([]);
  }
  findActiveMentorAssignmentsByUserIdCrossTenant(): Promise<GroupMentor[]> {
    return Promise.resolve([]);
  }
}

class FakeStaffRepo extends StaffMemberRepository {
  staff = new Map<string, StaffMember>();

  put(s: StaffMember): void {
    this.staff.set(s.id, s);
  }
  create(_input: CreateStaffMemberInput): Promise<StaffMember> {
    return Promise.reject(new Error('not used'));
  }
  findById(kindergartenId: string, id: string): Promise<StaffMember | null> {
    const s = this.staff.get(id);
    if (!s || s.kindergartenId !== kindergartenId) return Promise.resolve(null);
    return Promise.resolve(s);
  }
  findActiveByUserAndKindergarten(
    userId: string,
    kindergartenId: string,
  ): Promise<StaffMember | null> {
    const s = [...this.staff.values()].find(
      (x) =>
        x.userId === userId &&
        x.kindergartenId === kindergartenId &&
        x.isActive,
    );
    return Promise.resolve(s ?? null);
  }
  listByKindergarten(
    _kg: string,
    _filters?: ListStaffFilters,
  ): Promise<StaffMember[]> {
    return Promise.resolve([...this.staff.values()]);
  }
  update(
    _kg: string,
    _id: string,
    _changes: UpdateStaffMemberInput,
  ): Promise<StaffMember | null> {
    return Promise.resolve(null);
  }
  save(s: StaffMember): Promise<StaffMember> {
    this.put(s);
    return Promise.resolve(s);
  }
  deactivateAllByKindergarten(): Promise<number> {
    return Promise.resolve(0);
  }
  findAllActiveByUserId(userId: string): Promise<StaffMember[]> {
    return Promise.resolve(
      [...this.staff.values()].filter((s) => s.userId === userId && s.isActive),
    );
  }
}

class FakeUserRepo extends UserRepository {
  users = new Map<string, User>();
  byPhone = new Map<string, User>();

  put(u: User): void {
    this.users.set(u.id, u);
    this.byPhone.set(u.phone, u);
  }

  findById(id: string): Promise<User | null> {
    return Promise.resolve(this.users.get(id) ?? null);
  }
  findByPhone(phone: string): Promise<User | null> {
    return Promise.resolve(this.byPhone.get(phone) ?? null);
  }
  upsertByPhone(phone: string): Promise<User> {
    const existing = this.byPhone.get(phone);
    if (existing) return Promise.resolve(existing);
    const u = User.hydrate({
      id: randomUUID(),
      phone,
      fullName: '',
      avatarUrl: null,
      iin: null,
      dateOfBirth: null,
      locale: 'ru',
    });
    this.put(u);
    return Promise.resolve(u);
  }
  update(_id: string, _changes: UserUpdateInput): Promise<User> {
    return Promise.reject(new Error('not used'));
  }
}

/**
 * Minimal stub of TypeORM DataSource. ChildService.linkChildByIin uses
 * `dataSource.transaction(cb)` to scope its write into a tenant-bound TX —
 * the in-memory test only needs the lambda to run with a fake manager whose
 * `query()` is a no-op (the `SET LOCAL app.kindergarten_id` statement is
 * irrelevant to the fakes).
 */
const fakeManager = {
  query: (_sql: string): Promise<unknown> => Promise.resolve(undefined),
} as unknown as EntityManager;

const fakeDataSource = {
  transaction: <T>(cb: (m: EntityManager) => Promise<T>): Promise<T> =>
    cb(fakeManager),
} as unknown as DataSource;

class FakeNotification extends NotificationPort {
  events: { type: string; payload: unknown }[] = [];
  push(type: string, payload: unknown): Promise<void> {
    this.events.push({ type, payload });
    return Promise.resolve();
  }
  notifyGuardianPendingApproval(e: unknown): Promise<void> {
    return this.push('pending', e);
  }
  notifyGuardianApproved(e: unknown): Promise<void> {
    return this.push('approved', e);
  }
  notifyGuardianRejected(e: unknown): Promise<void> {
    return this.push('rejected', e);
  }
  notifyGuardianRevoked(e: unknown): Promise<void> {
    return this.push('revoked', e);
  }
  notifyChildTransferred(e: unknown): Promise<void> {
    return this.push('transferred', e);
  }
  notifyPermissionsUpdated(e: unknown): Promise<void> {
    return this.push('permissions_updated', e);
  }
  notifyAttendanceCheckIn(e: unknown): Promise<void> {
    return this.push('attendance_check_in', e);
  }
  notifyAttendanceCheckOut(e: unknown): Promise<void> {
    return this.push('attendance_check_out', e);
  }
  notifyDailyStatusChanged(e: unknown): Promise<void> {
    return this.push('daily_status_changed', e);
  }
  notifyTimelineEntryCreated(e: unknown): Promise<void> {
    return this.push('timeline_entry_created', e);
  }
  notifyGuardianSelfRevoked(e: unknown): Promise<void> {
    return this.push('guardian_self_revoked', e);
  }
  notifyPickupOtpSent(e: unknown): Promise<void> {
    return this.push('pickup_otp_sent', e);
  }
  notifyPickupValidated(e: unknown): Promise<void> {
    return this.push('pickup_validated', e);
  }
}

// ── helpers ───────────────────────────────────────────────────────────────

const KG = '11111111-1111-1111-1111-111111111111';
const KG2 = '22222222-2222-2222-2222-222222222222';
const NOW = new Date('2026-04-28T12:00:00.000Z');

function makeGroup(id: string, kg = KG): Group {
  return Group.hydrate({
    id,
    kindergartenId: kg,
    name: 'g',
    capacity: 10,
    ageRangeMin: null,
    ageRangeMax: null,
    currentLocationId: null,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function makeStaff(id: string, userId: string, kg = KG): StaffMember {
  return StaffMember.hydrate({
    id,
    kindergartenId: kg,
    userId,
    fullName: 's',
    phone: null,
    role: 'admin',
    specialistType: null,
    isActive: true,
    hiredAt: null,
    firedAt: null,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function makeUser(id: string, phone: string): User {
  return User.hydrate({
    id,
    phone,
    fullName: '',
    avatarUrl: null,
    iin: null,
    dateOfBirth: null,
    locale: 'ru',
  });
}

function setup() {
  const clock = new FakeClock(NOW);
  const children = new FakeChildRepo();
  const guardians = new FakeGuardianRepo();
  const groups = new FakeGroupRepo();
  const staff = new FakeStaffRepo();
  const users = new FakeUserRepo();
  const notification = new FakeNotification();
  const service = new ChildService(
    children,
    guardians,
    groups,
    staff,
    users,
    notification,
    clock,
    fakeDataSource,
  );
  return {
    clock,
    children,
    guardians,
    groups,
    staff,
    users,
    notification,
    service,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('ChildService — admin: createChild + updates', () => {
  it('creates a child with a unique IIN', async () => {
    const { service } = setup();
    const c = await service.createChild(KG, {
      fullName: 'Aigerim',
      iin: '040315500123',
      dateOfBirth: new Date('2021-09-15'),
    });
    expect(c.fullName).toBe('Aigerim');
    expect(c.status.value).toBe('card_created');
    expect(c.iin?.toString()).toBe('040315500123');
  });

  it('rejects duplicate IIN within the same kindergarten', async () => {
    const { service } = setup();
    await service.createChild(KG, {
      fullName: 'Aigerim',
      iin: '040315500123',
      dateOfBirth: new Date('2021-09-15'),
    });
    await expect(
      service.createChild(KG, {
        fullName: 'Bota',
        iin: '040315500123',
        dateOfBirth: new Date('2021-09-15'),
      }),
    ).rejects.toBeInstanceOf(ChildIinAlreadyExistsError);
  });

  it('rejects createChild when current_group_id does not exist', async () => {
    const { service } = setup();
    await expect(
      service.createChild(KG, {
        fullName: 'Aigerim',
        dateOfBirth: new Date('2021-09-15'),
        currentGroupId: '00000000-0000-0000-0000-000000000099',
      }),
    ).rejects.toBeInstanceOf(GroupNotFoundError);
  });

  it('updates the child profile (name, gender) and bumps updatedAt', async () => {
    const { service, clock } = setup();
    const c = await service.createChild(KG, {
      fullName: 'A',
      dateOfBirth: new Date('2021-09-15'),
    });
    clock.fixed = new Date('2026-04-28T13:00:00.000Z');
    const updated = await service.updateChildProfile(KG, c.id, {
      fullName: 'B',
      gender: 'female',
    });
    expect(updated.fullName).toBe('B');
    expect(updated.gender).toBe('female');
    expect(updated.updatedAt.toISOString()).toBe('2026-04-28T13:00:00.000Z');
  });

  it('archive/restore are idempotent', async () => {
    const { service } = setup();
    const c = await service.createChild(KG, {
      fullName: 'A',
      dateOfBirth: new Date('2021-09-15'),
    });
    await service.archiveChild(KG, c.id, 'reason');
    await service.archiveChild(KG, c.id, 'again'); // idempotent
    const got = await service.getChild(KG, c.id);
    expect(got.child.status.value).toBe('archived');
    await service.restoreChild(KG, c.id);
    const after = await service.getChild(KG, c.id);
    expect(after.child.status.value).toBe('active');
  });

  it('updateChildPhoto sets and clears the URL', async () => {
    const { service } = setup();
    const c = await service.createChild(KG, {
      fullName: 'A',
      dateOfBirth: new Date('2021-09-15'),
    });
    const u1 = await service.updateChildPhoto(KG, c.id, 'https://x/y.png');
    expect(u1.photoUrl).toBe('https://x/y.png');
    const u2 = await service.updateChildPhoto(KG, c.id, null);
    expect(u2.photoUrl).toBeUndefined();
  });

  it('throws ChildNotFoundError when childId belongs to another kg', async () => {
    const { service } = setup();
    const c = await service.createChild(KG, {
      fullName: 'A',
      dateOfBirth: new Date('2021-09-15'),
    });
    await expect(service.getChild(KG2, c.id)).rejects.toBeInstanceOf(
      ChildNotFoundError,
    );
  });
});

describe('ChildService — group transfer', () => {
  it('transfers child from one group to another, appending history', async () => {
    const { service, groups, staff, users, children } = setup();
    const u = makeUser(randomUUID(), '+77000000000');
    users.put(u);
    const stf = makeStaff(randomUUID(), u.id);
    staff.put(stf);
    const g1 = makeGroup(randomUUID());
    const g2 = makeGroup(randomUUID());
    groups.put(g1);
    groups.put(g2);
    const c = await service.createChild(KG, {
      fullName: 'A',
      dateOfBirth: new Date('2021-09-15'),
      currentGroupId: g1.id,
    });
    const out = await service.transferChildToGroup(
      KG,
      c.id,
      g2.id,
      stf.id,
      'r',
    );
    expect(out.toState().currentGroupId).toBe(g2.id);
    const history = await children.listGroupHistory(KG, c.id);
    expect(history.length).toBe(1);
    expect(history[0].fromGroupId).toBe(g1.id);
    expect(history[0].toGroupId).toBe(g2.id);
  });

  it('rejects transfer to the same group', async () => {
    const { service, groups, staff, users } = setup();
    const u = makeUser(randomUUID(), '+77000000000');
    users.put(u);
    const stf = makeStaff(randomUUID(), u.id);
    staff.put(stf);
    const g = makeGroup(randomUUID());
    groups.put(g);
    const c = await service.createChild(KG, {
      fullName: 'A',
      dateOfBirth: new Date('2021-09-15'),
      currentGroupId: g.id,
    });
    await expect(
      service.transferChildToGroup(KG, c.id, g.id, stf.id),
    ).rejects.toBeInstanceOf(GroupTransferToSelfError);
  });
});

describe('ChildService — guardian state machine', () => {
  async function bootChildWithPrimary(): Promise<{
    setup: ReturnType<typeof setup>;
    childId: string;
    primaryGuardianId: string;
    primaryUserId: string;
  }> {
    const ctx = setup();
    const primaryUser = makeUser(randomUUID(), '+77011110000');
    ctx.users.put(primaryUser);
    const child = await ctx.service.createChild(KG, {
      fullName: 'A',
      dateOfBirth: new Date('2021-09-15'),
    });
    // seed an APPROVED PRIMARY guardian directly
    const g = ChildGuardian.hydrate({
      id: randomUUID(),
      kindergartenId: KG,
      childId: child.id,
      userId: primaryUser.id,
      role: 'primary',
      status: 'approved',
      hasApprovalRights: false,
      approvedBy: null,
      approvedAt: NOW,
      revokedBy: null,
      revokedAt: null,
      canPickup: true,
      permissions: {},
      permissionsUpdatedBy: null,
      permissionsUpdatedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    ctx.guardians.put(g);
    return {
      setup: ctx,
      childId: child.id,
      primaryGuardianId: g.id,
      primaryUserId: primaryUser.id,
    };
  }

  it('admin invites a new guardian → pending_approval, primary is notified', async () => {
    const ctx = await bootChildWithPrimary();
    const { service, notification } = ctx.setup;
    const guardian = await service.inviteGuardian(KG, {
      childId: ctx.childId,
      userPhone: '+77011112222',
      role: 'secondary',
      invitedByUserId: ctx.primaryUserId,
    });
    expect(guardian.status.value).toBe('pending_approval');
    expect(guardian.role.value).toBe('secondary');
    expect(notification.events.find((e) => e.type === 'pending')).toBeDefined();
  });

  it('rejects double-invite of the same user (DuplicateGuardianError)', async () => {
    const ctx = await bootChildWithPrimary();
    const { service } = ctx.setup;
    await service.inviteGuardian(KG, {
      childId: ctx.childId,
      userPhone: '+77011112222',
      role: 'secondary',
      invitedByUserId: ctx.primaryUserId,
    });
    await expect(
      service.inviteGuardian(KG, {
        childId: ctx.childId,
        userPhone: '+77011112222',
        role: 'nanny',
        invitedByUserId: ctx.primaryUserId,
      }),
    ).rejects.toBeInstanceOf(DuplicateGuardianError);
  });

  it('approve transitions pending → approved; second approve fails', async () => {
    const ctx = await bootChildWithPrimary();
    const { service } = ctx.setup;
    const g = await service.inviteGuardian(KG, {
      childId: ctx.childId,
      userPhone: '+77011112222',
      role: 'secondary',
      invitedByUserId: ctx.primaryUserId,
    });
    const approved = await service.approveGuardian(
      KG,
      ctx.primaryUserId,
      g.id,
      false,
    );
    expect(approved.status.value).toBe('approved');
    await expect(
      service.approveGuardian(KG, ctx.primaryUserId, g.id, false),
    ).rejects.toBeInstanceOf(InvalidGuardianStatusTransitionError);
  });

  it('reject transitions pending → rejected; cannot approve afterwards', async () => {
    const ctx = await bootChildWithPrimary();
    const { service } = ctx.setup;
    const g = await service.inviteGuardian(KG, {
      childId: ctx.childId,
      userPhone: '+77011112222',
      role: 'secondary',
      invitedByUserId: ctx.primaryUserId,
    });
    const rejected = await service.rejectGuardian(KG, ctx.primaryUserId, g.id);
    expect(rejected.status.value).toBe('rejected');
    await expect(
      service.approveGuardian(KG, ctx.primaryUserId, g.id, false),
    ).rejects.toBeInstanceOf(InvalidGuardianStatusTransitionError);
  });

  it('revoke (admin) on approved → revoked; subsequent revoke fails', async () => {
    const ctx = await bootChildWithPrimary();
    const { service } = ctx.setup;
    const g = await service.inviteGuardian(KG, {
      childId: ctx.childId,
      userPhone: '+77011112222',
      role: 'secondary',
      invitedByUserId: ctx.primaryUserId,
    });
    await service.approveGuardian(KG, ctx.primaryUserId, g.id, false);
    await service.revokeGuardianByAdmin(
      KG,
      ctx.childId,
      g.id,
      ctx.primaryUserId,
    );
    await expect(
      service.revokeGuardianByAdmin(KG, ctx.childId, g.id, ctx.primaryUserId),
    ).rejects.toBeInstanceOf(InvalidGuardianStatusTransitionError);
  });

  it('non-primary caller cannot approve guardians', async () => {
    const ctx = await bootChildWithPrimary();
    const { service } = ctx.setup;
    const g = await service.inviteGuardian(KG, {
      childId: ctx.childId,
      userPhone: '+77011112222',
      role: 'secondary',
      invitedByUserId: ctx.primaryUserId,
    });
    await expect(
      service.approveGuardian(
        KG,
        '99999999-9999-9999-9999-999999999999',
        g.id,
        false,
      ),
    ).rejects.toBeInstanceOf(NotPrimaryGuardianError);
  });

  it('approval-rights cap of 2 is enforced', async () => {
    const ctx = await bootChildWithPrimary();
    const { service, guardians } = ctx.setup;
    // primary already has approval-rights = false; grant it via toggle.
    await service.toggleGuardianApprovalRights(
      KG,
      ctx.primaryUserId,
      ctx.primaryGuardianId,
      true,
    );
    // invite + approve a 2nd with rights
    const g2 = await service.inviteGuardian(KG, {
      childId: ctx.childId,
      userPhone: '+77011112222',
      role: 'secondary',
      invitedByUserId: ctx.primaryUserId,
    });
    await service.approveGuardian(KG, ctx.primaryUserId, g2.id, true);
    // invite a 3rd; trying to grant rights at approve must fail.
    const g3 = await service.inviteGuardian(KG, {
      childId: ctx.childId,
      userPhone: '+77011113333',
      role: 'secondary',
      invitedByUserId: ctx.primaryUserId,
    });
    await expect(
      service.approveGuardian(KG, ctx.primaryUserId, g3.id, true),
    ).rejects.toBeInstanceOf(MaxApprovalRightsExceededError);
    // toggleApprovalRights also caps:
    await service.approveGuardian(KG, ctx.primaryUserId, g3.id, false);
    await expect(
      service.toggleGuardianApprovalRights(KG, ctx.primaryUserId, g3.id, true),
    ).rejects.toBeInstanceOf(MaxApprovalRightsExceededError);
    void guardians;
  });

  it('updateGuardianPermissions requires status=approved', async () => {
    const ctx = await bootChildWithPrimary();
    const { service } = ctx.setup;
    const g = await service.inviteGuardian(KG, {
      childId: ctx.childId,
      userPhone: '+77011112222',
      role: 'secondary',
      invitedByUserId: ctx.primaryUserId,
    });
    await expect(
      service.updateGuardianPermissions(KG, ctx.primaryUserId, g.id, {
        view_cctv: false,
      }),
    ).rejects.toBeInstanceOf(GuardianNotApprovedError);
  });

  it('updateGuardianPermissions persists overrides and produces effective map', async () => {
    const ctx = await bootChildWithPrimary();
    const { service } = ctx.setup;
    const g = await service.inviteGuardian(KG, {
      childId: ctx.childId,
      userPhone: '+77011112222',
      role: 'secondary',
      invitedByUserId: ctx.primaryUserId,
    });
    await service.approveGuardian(KG, ctx.primaryUserId, g.id, false);
    const out = await service.updateGuardianPermissions(
      KG,
      ctx.primaryUserId,
      g.id,
      { view_cctv: false },
    );
    expect(out.effective.view_cctv).toBe(false);
    expect(out.effective.view_timeline).toBe(true);
  });

  it('listMyChildren returns only children where the user is APPROVED guardian', async () => {
    const ctx = await bootChildWithPrimary();
    const { service } = ctx.setup;
    const otherChild = await service.createChild(KG, {
      fullName: 'B',
      dateOfBirth: new Date('2021-09-15'),
    });
    void otherChild;
    const rows = await service.listMyChildren(KG, ctx.primaryUserId);
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(ctx.childId);
  });

  it('updateGuardianRoleAndPickup throws GuardianNotFoundError if id mismatches childId', async () => {
    const ctx = await bootChildWithPrimary();
    const { service } = ctx.setup;
    const otherChild = await service.createChild(KG, {
      fullName: 'B',
      dateOfBirth: new Date('2021-09-15'),
    });
    await expect(
      service.updateGuardianRoleAndPickup(
        KG,
        otherChild.id,
        ctx.primaryGuardianId,
        { canPickup: false },
      ),
    ).rejects.toBeInstanceOf(GuardianNotFoundError);
  });
});

// ── B6: parent-side cross-tenant link / self-unlink ──────────────────────

describe('ChildService — linkChildByIin', () => {
  /**
   * Bootstraps a `KG` kindergarten with one child + one approved primary
   * guardian. Returns the child id, child IIN, and the caller user id used
   * across all happy-path link tests.
   */
  async function bootChildWithIinAndPrimary(): Promise<{
    setup: ReturnType<typeof setup>;
    childId: string;
    childIin: string;
    primaryUserId: string;
    callerUserId: string;
  }> {
    const ctx = setup();
    const primaryUser = makeUser(randomUUID(), '+77011110000');
    ctx.users.put(primaryUser);
    const callerUser = makeUser(randomUUID(), '+77011112222');
    ctx.users.put(callerUser);
    const childIin = '040315500123';
    const child = await ctx.service.createChild(KG, {
      fullName: 'A',
      iin: childIin,
      dateOfBirth: new Date('2021-09-15'),
    });
    const g = ChildGuardian.hydrate({
      id: randomUUID(),
      kindergartenId: KG,
      childId: child.id,
      userId: primaryUser.id,
      role: 'primary',
      status: 'approved',
      hasApprovalRights: true,
      approvedBy: primaryUser.id,
      approvedAt: NOW,
      revokedBy: null,
      revokedAt: null,
      canPickup: true,
      permissions: {},
      permissionsUpdatedBy: null,
      permissionsUpdatedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    ctx.guardians.put(g);
    return {
      setup: ctx,
      childId: child.id,
      childIin,
      primaryUserId: primaryUser.id,
      callerUserId: callerUser.id,
    };
  }

  it('creates a pending secondary guardian for a found child', async () => {
    const ctx = await bootChildWithIinAndPrimary();
    const { service, notification, guardians } = ctx.setup;
    const out = await service.linkChildByIin(ctx.callerUserId, {
      iin: ctx.childIin,
      role: 'secondary',
    });
    expect(out.child.id).toBe(ctx.childId);
    expect(out.guardian.status.value).toBe('pending_approval');
    expect(out.guardian.role.value).toBe('secondary');
    expect(out.guardian.canPickup).toBe(false); // default when omitted
    expect(out.guardian.userId).toBe(ctx.callerUserId);
    // primary was notified once
    const pending = notification.events.filter((e) => e.type === 'pending');
    expect(pending.length).toBe(1);
    expect(
      (pending[0].payload as { primaryUserId: string }).primaryUserId,
    ).toBe(ctx.primaryUserId);
    // row landed in store
    expect(guardians.guardians.get(out.guardian.id)).toBeDefined();
  });

  it('honours canPickup=true when explicitly set', async () => {
    const ctx = await bootChildWithIinAndPrimary();
    const { service } = ctx.setup;
    const out = await service.linkChildByIin(ctx.callerUserId, {
      iin: ctx.childIin,
      role: 'nanny',
      canPickup: true,
    });
    expect(out.guardian.role.value).toBe('nanny');
    expect(out.guardian.canPickup).toBe(true);
  });

  it('throws ChildNotFoundForIinError when iin matches no child', async () => {
    const ctx = setup();
    await expect(
      ctx.service.linkChildByIin('00000000-0000-0000-0000-000000000099', {
        iin: '040315500999',
        role: 'secondary',
      }),
    ).rejects.toBeInstanceOf(ChildNotFoundForIinError);
  });

  it('throws MultipleChildrenForIinError with kindergartenIds when iin matches multiple children', async () => {
    const ctx = setup();
    const callerUser = makeUser(randomUUID(), '+77011112222');
    ctx.users.put(callerUser);
    const sharedIin = '040315500444';
    await ctx.service.createChild(KG, {
      fullName: 'A1',
      iin: sharedIin,
      dateOfBirth: new Date('2021-09-15'),
    });
    await ctx.service.createChild(KG2, {
      fullName: 'A2',
      iin: sharedIin,
      dateOfBirth: new Date('2021-09-15'),
    });
    let captured: MultipleChildrenForIinError | null = null;
    try {
      await ctx.service.linkChildByIin(callerUser.id, {
        iin: sharedIin,
        role: 'secondary',
      });
    } catch (err) {
      captured = err as MultipleChildrenForIinError;
    }
    expect(captured).toBeInstanceOf(MultipleChildrenForIinError);
    expect(captured!.kindergartenIds).toEqual(
      expect.arrayContaining([KG, KG2]),
    );
    expect(captured!.kindergartenIds.length).toBe(2);
  });

  it('throws AlreadyLinkedToChildError when caller already approved on the child', async () => {
    const ctx = await bootChildWithIinAndPrimary();
    const { service, guardians } = ctx.setup;
    const existing = ChildGuardian.hydrate({
      id: randomUUID(),
      kindergartenId: KG,
      childId: ctx.childId,
      userId: ctx.callerUserId,
      role: 'secondary',
      status: 'approved',
      hasApprovalRights: false,
      approvedBy: ctx.primaryUserId,
      approvedAt: NOW,
      revokedBy: null,
      revokedAt: null,
      canPickup: false,
      permissions: {},
      permissionsUpdatedBy: null,
      permissionsUpdatedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    guardians.put(existing);
    await expect(
      service.linkChildByIin(ctx.callerUserId, {
        iin: ctx.childIin,
        role: 'secondary',
      }),
    ).rejects.toBeInstanceOf(AlreadyLinkedToChildError);
  });

  it('throws AlreadyPendingForChildError when caller already pending on the child', async () => {
    const ctx = await bootChildWithIinAndPrimary();
    const { service, guardians } = ctx.setup;
    const existing = ChildGuardian.hydrate({
      id: randomUUID(),
      kindergartenId: KG,
      childId: ctx.childId,
      userId: ctx.callerUserId,
      role: 'secondary',
      status: 'pending_approval',
      hasApprovalRights: false,
      approvedBy: null,
      approvedAt: null,
      revokedBy: null,
      revokedAt: null,
      canPickup: false,
      permissions: {},
      permissionsUpdatedBy: null,
      permissionsUpdatedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    guardians.put(existing);
    await expect(
      service.linkChildByIin(ctx.callerUserId, {
        iin: ctx.childIin,
        role: 'secondary',
      }),
    ).rejects.toBeInstanceOf(AlreadyPendingForChildError);
  });

  it('allows new pending row when prior row is revoked', async () => {
    const ctx = await bootChildWithIinAndPrimary();
    const { service, guardians } = ctx.setup;
    const revoked = ChildGuardian.hydrate({
      id: randomUUID(),
      kindergartenId: KG,
      childId: ctx.childId,
      userId: ctx.callerUserId,
      role: 'secondary',
      status: 'revoked',
      hasApprovalRights: false,
      approvedBy: ctx.primaryUserId,
      approvedAt: NOW,
      revokedBy: ctx.callerUserId,
      revokedAt: NOW,
      canPickup: false,
      permissions: {},
      permissionsUpdatedBy: null,
      permissionsUpdatedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    guardians.put(revoked);
    const out = await service.linkChildByIin(ctx.callerUserId, {
      iin: ctx.childIin,
      role: 'secondary',
    });
    expect(out.guardian.status.value).toBe('pending_approval');
    expect(out.guardian.id).not.toBe(revoked.id);
  });
});

describe('ChildService — selfUnlinkFromChild', () => {
  async function bootApprovedSecondary(): Promise<{
    setup: ReturnType<typeof setup>;
    childId: string;
    primaryUserId: string;
    secondaryUserId: string;
    secondaryGuardianId: string;
  }> {
    const ctx = setup();
    const primaryUser = makeUser(randomUUID(), '+77011110000');
    ctx.users.put(primaryUser);
    const secondaryUser = makeUser(randomUUID(), '+77011112222');
    ctx.users.put(secondaryUser);
    const child = await ctx.service.createChild(KG, {
      fullName: 'A',
      dateOfBirth: new Date('2021-09-15'),
    });
    const primaryRow = ChildGuardian.hydrate({
      id: randomUUID(),
      kindergartenId: KG,
      childId: child.id,
      userId: primaryUser.id,
      role: 'primary',
      status: 'approved',
      hasApprovalRights: true,
      approvedBy: primaryUser.id,
      approvedAt: NOW,
      revokedBy: null,
      revokedAt: null,
      canPickup: true,
      permissions: {},
      permissionsUpdatedBy: null,
      permissionsUpdatedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    ctx.guardians.put(primaryRow);
    const secondaryRow = ChildGuardian.hydrate({
      id: randomUUID(),
      kindergartenId: KG,
      childId: child.id,
      userId: secondaryUser.id,
      role: 'secondary',
      status: 'approved',
      hasApprovalRights: false,
      approvedBy: primaryUser.id,
      approvedAt: NOW,
      revokedBy: null,
      revokedAt: null,
      canPickup: true,
      permissions: {},
      permissionsUpdatedBy: null,
      permissionsUpdatedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    ctx.guardians.put(secondaryRow);
    return {
      setup: ctx,
      childId: child.id,
      primaryUserId: primaryUser.id,
      secondaryUserId: secondaryUser.id,
      secondaryGuardianId: secondaryRow.id,
    };
  }

  it('revokes an approved secondary guardian', async () => {
    const ctx = await bootApprovedSecondary();
    const { service, guardians } = ctx.setup;
    await service.selfUnlinkFromChild(KG, ctx.secondaryUserId, ctx.childId);
    const after = guardians.guardians.get(ctx.secondaryGuardianId);
    expect(after?.status.value).toBe('revoked');
    expect(after?.revokedBy).toBe(ctx.secondaryUserId);
    expect(after?.revokedAt).toEqual(NOW);
  });

  it('emits notifyGuardianSelfRevoked with correct payload', async () => {
    const ctx = await bootApprovedSecondary();
    const { service, notification } = ctx.setup;
    await service.selfUnlinkFromChild(KG, ctx.secondaryUserId, ctx.childId);
    const selfRevokedEvents = notification.events.filter(
      (e) => e.type === 'guardian_self_revoked',
    );
    expect(selfRevokedEvents).toHaveLength(1);
    const payload = selfRevokedEvents[0].payload as {
      kindergartenId: string;
      childId: string;
      userId: string;
      revokedAt: Date;
    };
    expect(payload.kindergartenId).toBe(KG);
    expect(payload.childId).toBe(ctx.childId);
    expect(payload.userId).toBe(ctx.secondaryUserId);
    expect(payload.revokedAt).toEqual(NOW);
  });

  it('revokes an approved nanny guardian', async () => {
    const ctx = await bootApprovedSecondary();
    const { service, guardians } = ctx.setup;
    const nannyUser = makeUser(randomUUID(), '+77011113333');
    ctx.setup.users.put(nannyUser);
    const nannyRow = ChildGuardian.hydrate({
      id: randomUUID(),
      kindergartenId: KG,
      childId: ctx.childId,
      userId: nannyUser.id,
      role: 'nanny',
      status: 'approved',
      hasApprovalRights: false,
      approvedBy: ctx.primaryUserId,
      approvedAt: NOW,
      revokedBy: null,
      revokedAt: null,
      canPickup: true,
      permissions: {},
      permissionsUpdatedBy: null,
      permissionsUpdatedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    guardians.put(nannyRow);
    await service.selfUnlinkFromChild(KG, nannyUser.id, ctx.childId);
    const after = guardians.guardians.get(nannyRow.id);
    expect(after?.status.value).toBe('revoked');
    expect(after?.revokedBy).toBe(nannyUser.id);
  });

  it('throws PrimaryCannotSelfUnlinkError for primary', async () => {
    const ctx = await bootApprovedSecondary();
    const { service } = ctx.setup;
    await expect(
      service.selfUnlinkFromChild(KG, ctx.primaryUserId, ctx.childId),
    ).rejects.toBeInstanceOf(PrimaryCannotSelfUnlinkError);
  });

  it('throws ChildAccessDeniedError when caller has no guardian row', async () => {
    const ctx = await bootApprovedSecondary();
    const { service } = ctx.setup;
    await expect(
      service.selfUnlinkFromChild(
        KG,
        '00000000-0000-0000-0000-000000000099',
        ctx.childId,
      ),
    ).rejects.toBeInstanceOf(ChildAccessDeniedError);
  });

  it('throws ChildAccessDeniedError when caller is only pending', async () => {
    const ctx = await bootApprovedSecondary();
    const { service, guardians } = ctx.setup;
    const pendingUser = makeUser(randomUUID(), '+77011114444');
    ctx.setup.users.put(pendingUser);
    const pendingRow = ChildGuardian.hydrate({
      id: randomUUID(),
      kindergartenId: KG,
      childId: ctx.childId,
      userId: pendingUser.id,
      role: 'secondary',
      status: 'pending_approval',
      hasApprovalRights: false,
      approvedBy: null,
      approvedAt: null,
      revokedBy: null,
      revokedAt: null,
      canPickup: false,
      permissions: {},
      permissionsUpdatedBy: null,
      permissionsUpdatedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    guardians.put(pendingRow);
    await expect(
      service.selfUnlinkFromChild(KG, pendingUser.id, ctx.childId),
    ).rejects.toBeInstanceOf(ChildAccessDeniedError);
  });
});
