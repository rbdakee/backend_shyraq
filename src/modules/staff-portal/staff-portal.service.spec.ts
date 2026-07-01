/**
 * StaffPortalService — service-unit suite. Hand-written in-memory fakes for
 * every collaborator (no Jest auto-mock), per CLAUDE.md §7.
 *
 * Coverage:
 *   - my-groups: primary flag, age_range bounds, room (with + without
 *     location), children_count, skips missing groups.
 *   - roster: filters to active+group, overlays today's day_status, cursor
 *     pagination (full page → next_cursor, last page → null), mentor-not-
 *     assigned guard, and a kg_A vs kg_B phantom-row cross-tenant assertion.
 *   - specialist children: kg-wide active scope, cursor pagination.
 *   - child card: allergies array wrap (value → ["…"], null → []), guardian
 *     overlay (full_name/phone/relation/can_pickup), approved-only filter,
 *     group_name overlay, 404 passthrough.
 *   - cursor.util: round-trip + malformed rejection.
 *
 * Test names use `it('returns …')` / `it('throws …')` — never `it('should …')`.
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  Child,
  ChildState,
} from '@/modules/child/domain/entities/child.entity';
import { ChildGuardian } from '@/modules/child/domain/entities/child-guardian.entity';
import { ChildNotFoundError } from '@/modules/child/domain/errors/child-not-found.error';
import { GuardianRelation } from '@/shared-kernel/domain/value-objects/guardian-relation.vo';
import { ChildGuardianRepository } from '@/modules/child/infrastructure/persistence/child-guardian.repository';
import {
  ChildListFilters,
  ChildRepository,
  PageRequest,
  PageResult,
} from '@/modules/child/infrastructure/persistence/child.repository';
import { ChildService } from '@/modules/child/child.service';
import { Group } from '@/modules/group/domain/entities/group.entity';
import { GroupMentor } from '@/modules/group/domain/entities/group-mentor.entity';
import { GroupRepository } from '@/modules/group/infrastructure/persistence/group.repository';
import { Location } from '@/modules/location/domain/entities/location.entity';
import { LocationRepository } from '@/modules/location/infrastructure/persistence/location.repository';
import { ChildDailyStatus } from '@/modules/attendance/domain/entities/child-daily-status.entity';
import { ChildIntradayStatus } from '@/modules/attendance/domain/value-objects/child-intraday-status.vo';
import {
  ChildDailyStatusRepository,
  ListDailyStatusFilter,
} from '@/modules/attendance/infrastructure/persistence/child-daily-status.repository';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { decodeCursor, encodeCursor } from './cursor.util';
import { formatAgeRange, StaffPortalPresenter } from './staff-portal.presenter';
import { StaffPortalService } from './staff-portal.service';

// ── Constants ──────────────────────────────────────────────────────────────

const KG_A = '11111111-1111-1111-1111-111111111111';
const KG_B = '22222222-2222-2222-2222-222222222222';
const MENTOR = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa';
const GROUP_A = 'a1a1a1a1-0000-0000-0000-000000000001';
const GROUP_B = 'b2b2b2b2-0000-0000-0000-000000000001';
const LOCATION_A = 'cccccccc-0000-0000-0000-000000000001';
const NOW = new Date('2026-06-24T09:00:00.000Z'); // Almaty: 2026-06-24 14:00

// ── Clock ────────────────────────────────────────────────────────────────

class FixedClock extends ClockPort {
  constructor(private fixed: Date) {
    super();
  }
  now(): Date {
    return this.fixed;
  }
}

// ── Domain fixture helpers ──────────────────────────────────────────────────

function makeChild(
  over: Partial<ChildState> & { id: string; kindergartenId: string },
): Child {
  return Child.hydrate({
    id: over.id,
    kindergartenId: over.kindergartenId,
    iin: over.iin ?? null,
    fullName: over.fullName ?? 'Алихан Сериков',
    dateOfBirth: over.dateOfBirth ?? new Date('2020-06-14T00:00:00.000Z'),
    gender: over.gender ?? null,
    photoUrl: over.photoUrl ?? null,
    status: over.status ?? 'active',
    currentGroupId: over.currentGroupId ?? null,
    enrollmentDate: over.enrollmentDate ?? null,
    archivedAt: over.archivedAt ?? null,
    archiveReason: over.archiveReason ?? null,
    medicalNotes: over.medicalNotes ?? null,
    allergyNotes: over.allergyNotes ?? null,
    createdAt: over.createdAt ?? NOW,
    updatedAt: over.updatedAt ?? NOW,
  });
}

function makeGroup(over: {
  id: string;
  kindergartenId: string;
  name?: string;
  ageRangeMin?: number | null;
  ageRangeMax?: number | null;
  currentLocationId?: string | null;
}): Group {
  return Group.hydrate({
    id: over.id,
    kindergartenId: over.kindergartenId,
    name: over.name ?? 'Күншуақ',
    capacity: 25,
    ageRangeMin: over.ageRangeMin ?? null,
    ageRangeMax: over.ageRangeMax ?? null,
    currentLocationId: over.currentLocationId ?? null,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function makeMentor(over: {
  kindergartenId: string;
  groupId: string;
  isPrimary?: boolean;
}): GroupMentor {
  return GroupMentor.hydrate({
    id: randomUUID(),
    kindergartenId: over.kindergartenId,
    groupId: over.groupId,
    staffMemberId: randomUUID(),
    isPrimary: over.isPrimary ?? false,
    assignedAt: NOW,
    unassignedAt: null,
    createdAt: NOW,
  });
}

function makeGuardian(over: {
  kindergartenId: string;
  childId: string;
  userId: string;
  role?: 'primary' | 'secondary' | 'nanny';
  status?: 'pending_approval' | 'approved' | 'rejected' | 'revoked';
  canPickup?: boolean;
}): ChildGuardian {
  return ChildGuardian.hydrate({
    id: randomUUID(),
    kindergartenId: over.kindergartenId,
    childId: over.childId,
    userId: over.userId,
    role: over.role ?? 'primary',
    status: over.status ?? 'approved',
    hasApprovalRights: false,
    approvedBy: null,
    approvedAt: null,
    revokedBy: null,
    revokedAt: null,
    canPickup: over.canPickup ?? true,
    permissions: {},
    permissionsUpdatedBy: null,
    permissionsUpdatedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function makeDaily(over: {
  kindergartenId: string;
  childId: string;
  date: string;
  status: ChildIntradayStatus;
}): ChildDailyStatus {
  return ChildDailyStatus.hydrate({
    id: randomUUID(),
    kindergartenId: over.kindergartenId,
    childId: over.childId,
    date: over.date,
    status: over.status.value,
    note: null,
    setBy: null,
    updatedAt: NOW,
  });
}

// ── Fakes ────────────────────────────────────────────────────────────────

class FakeGroupRepo extends GroupRepository {
  groups: Group[] = [];
  mentors: GroupMentor[] = [];

  create(): Promise<Group> {
    throw new Error('not used');
  }
  findById(kg: string, id: string): Promise<Group | null> {
    return Promise.resolve(
      this.groups.find((g) => g.kindergartenId === kg && g.id === id) ?? null,
    );
  }
  list(): Promise<Group[]> {
    throw new Error('not used');
  }
  update(): Promise<Group | null> {
    throw new Error('not used');
  }
  save(): Promise<Group> {
    throw new Error('not used');
  }
  assignMentor(): Promise<GroupMentor> {
    throw new Error('not used');
  }
  unassignMentor(): Promise<GroupMentor | null> {
    throw new Error('not used');
  }
  unassignMentorByStaffMember(): Promise<number> {
    throw new Error('not used');
  }
  findActiveMentor(): Promise<GroupMentor | null> {
    throw new Error('not used');
  }
  listMentorHistory(): Promise<GroupMentor[]> {
    throw new Error('not used');
  }
  findActiveMentorAssignmentsByUserIdCrossTenant(
    _userId: string,
    kindergartenId?: string,
  ): Promise<GroupMentor[]> {
    // The relational impl filters to active rows whose staff_member resolves to
    // userId; the fake just returns the seeded mentors, scoped to kg when given.
    const rows =
      kindergartenId === undefined
        ? this.mentors
        : this.mentors.filter((m) => m.kindergartenId === kindergartenId);
    return Promise.resolve(rows);
  }
}

class FakeLocationRepo extends LocationRepository {
  locations: Location[] = [];

  create(): Promise<Location> {
    throw new Error('not used');
  }
  findById(kg: string, id: string): Promise<Location | null> {
    return Promise.resolve(
      this.locations.find((l) => l.kindergartenId === kg && l.id === id) ??
        null,
    );
  }
  list(): Promise<Location[]> {
    throw new Error('not used');
  }
  update(): Promise<Location | null> {
    throw new Error('not used');
  }
  save(): Promise<Location> {
    throw new Error('not used');
  }
}

class FakeChildRepo extends ChildRepository {
  children: Child[] = [];

  create(): Promise<void> {
    throw new Error('not used');
  }
  findById(kg: string, id: string): Promise<Child | null> {
    return Promise.resolve(
      this.children.find(
        (c) => (c.kindergartenId as string) === kg && (c.id as string) === id,
      ) ?? null,
    );
  }
  findByKindergartenAndIin(): Promise<Child | null> {
    throw new Error('not used');
  }
  update(): Promise<void> {
    throw new Error('not used');
  }
  list(
    kg: string,
    filters: ChildListFilters,
    page: PageRequest,
  ): Promise<PageResult<Child>> {
    const matched = this.children.filter((c) => {
      const s = c.toState();
      if ((c.kindergartenId as string) !== kg) return false;
      if (filters.status && s.status !== filters.status) return false;
      if (filters.currentGroupId && s.currentGroupId !== filters.currentGroupId)
        return false;
      return true;
    });
    const items = matched.slice(page.offset, page.offset + page.limit);
    return Promise.resolve({ items, total: matched.length });
  }
  countActiveByGroup(kg: string, groupId: string): Promise<number> {
    return Promise.resolve(
      this.children.filter((c) => {
        const s = c.toState();
        return (
          (c.kindergartenId as string) === kg &&
          s.status === 'active' &&
          s.currentGroupId === groupId
        );
      }).length,
    );
  }
  recordGroupTransfer(): Promise<void> {
    throw new Error('not used');
  }
  listGroupHistory(): Promise<never[]> {
    throw new Error('not used');
  }
  findByIinCrossTenant(): Promise<Child[]> {
    throw new Error('not used');
  }
  findByIdsCrossTenant(): Promise<Child[]> {
    throw new Error('not used');
  }
}

class FakeGuardianRepo extends ChildGuardianRepository {
  guardians: ChildGuardian[] = [];

  create(): Promise<void> {
    throw new Error('not used');
  }
  findById(): Promise<ChildGuardian | null> {
    throw new Error('not used');
  }
  findByChildId(kg: string, childId: string): Promise<ChildGuardian[]> {
    return Promise.resolve(
      this.guardians.filter(
        (g) =>
          (g.kindergartenId as string) === kg &&
          (g.childId as string) === childId,
      ),
    );
  }
  findActiveByChildAndUser(): Promise<ChildGuardian | null> {
    throw new Error('not used');
  }
  findApprovedByChildAndUserCrossTenant(): Promise<ChildGuardian | null> {
    throw new Error('not used');
  }
  findByIdCrossTenant(): Promise<ChildGuardian | null> {
    throw new Error('not used');
  }
  findPendingForPrimary(): Promise<ChildGuardian[]> {
    throw new Error('not used');
  }
  update(): Promise<void> {
    throw new Error('not used');
  }
  countApprovalRights(): Promise<number> {
    throw new Error('not used');
  }
  acquireApprovalRightsLock(): Promise<void> {
    throw new Error('not used');
  }
  listApprovedKindergartenIdsByUserId(): Promise<string[]> {
    throw new Error('not used');
  }
  findApprovedByUser(): Promise<ChildGuardian[]> {
    throw new Error('not used');
  }
  findPendingPrimaryByUserIdCrossTenant(): Promise<ChildGuardian[]> {
    throw new Error('not used');
  }
  findApprovedActivePickupGuardian(): Promise<ChildGuardian | null> {
    throw new Error('not used');
  }
  findApprovedActiveByUserIdCrossTenant(): Promise<ChildGuardian[]> {
    throw new Error('not used');
  }
  findApprovedActiveByUserAndChild(): Promise<ChildGuardian | null> {
    throw new Error('not used');
  }
}

class FakeDailyStatusRepo extends ChildDailyStatusRepository {
  rows: ChildDailyStatus[] = [];
  lastFilter: ListDailyStatusFilter | null = null;

  findByChildAndDate(): Promise<ChildDailyStatus | null> {
    throw new Error('not used');
  }
  upsert(): Promise<ChildDailyStatus> {
    throw new Error('not used');
  }
  save(): Promise<ChildDailyStatus> {
    throw new Error('not used');
  }
  updatePresentIfAbsentOrLate(): Promise<{
    updated: boolean;
    current: ChildDailyStatus | null;
  }> {
    throw new Error('not used');
  }
  list(kg: string, filter: ListDailyStatusFilter): Promise<ChildDailyStatus[]> {
    this.lastFilter = filter;
    return Promise.resolve(
      this.rows.filter((r) => {
        if (r.kindergartenId !== kg) return false;
        if (filter.from && r.date < filter.from) return false;
        if (filter.to && r.date > filter.to) return false;
        return true;
      }),
    );
  }
}

// ── Identity stub for ChildService.resolveGuardianIdentities / resolveGroupName

class StubChildService {
  constructor(
    private readonly childRepo: FakeChildRepo,
    private readonly guardianRepo: FakeGuardianRepo,
    private readonly groupRepo: FakeGroupRepo,
    private readonly identities: Map<
      string,
      { fullName: string | null; phone: string | null }
    >,
  ) {}

  async getChild(
    kgId: string,
    childId: string,
  ): Promise<{ child: Child; guardians: ChildGuardian[] }> {
    const child = await this.childRepo.findById(kgId, childId);
    if (!child) throw new ChildNotFoundError(childId);
    const guardians = await this.guardianRepo.findByChildId(kgId, childId);
    return { child, guardians };
  }

  async resolveGroupName(kgId: string, child: Child): Promise<string | null> {
    const gid = child.toState().currentGroupId;
    if (!gid) return null;
    const group = await this.groupRepo.findById(kgId, gid);
    return group?.name ?? null;
  }

  resolveGuardianIdentities(
    guardians: ChildGuardian[],
  ): Promise<Map<string, { fullName: string | null; phone: string | null }>> {
    const out = new Map<
      string,
      { fullName: string | null; phone: string | null }
    >();
    for (const g of guardians) {
      out.set(
        g.userId as string,
        this.identities.get(g.userId as string) ?? {
          fullName: null,
          phone: null,
        },
      );
    }
    return Promise.resolve(out);
  }
}

// ── Wiring ──────────────────────────────────────────────────────────────────

interface Harness {
  service: StaffPortalService;
  groupRepo: FakeGroupRepo;
  locationRepo: FakeLocationRepo;
  childRepo: FakeChildRepo;
  guardianRepo: FakeGuardianRepo;
  dailyRepo: FakeDailyStatusRepo;
  identities: Map<string, { fullName: string | null; phone: string | null }>;
}

function build(): Harness {
  const groupRepo = new FakeGroupRepo();
  const locationRepo = new FakeLocationRepo();
  const childRepo = new FakeChildRepo();
  const guardianRepo = new FakeGuardianRepo();
  const dailyRepo = new FakeDailyStatusRepo();
  const identities = new Map<
    string,
    { fullName: string | null; phone: string | null }
  >();

  const childService = new StubChildService(
    childRepo,
    guardianRepo,
    groupRepo,
    identities,
  ) as unknown as ChildService;

  const service = new StaffPortalService(
    groupRepo,
    locationRepo,
    childService,
    childRepo,
    dailyRepo,
    new FixedClock(NOW),
  );

  return {
    service,
    groupRepo,
    locationRepo,
    childRepo,
    guardianRepo,
    dailyRepo,
    identities,
  };
}

// ── cursor.util ──────────────────────────────────────────────────────────────

describe('cursor.util', () => {
  it('returns the original offset on encode→decode round-trip', () => {
    for (const n of [0, 1, 20, 40, 12345]) {
      expect(decodeCursor(encodeCursor(n))).toBe(n);
    }
  });

  it('throws BadRequestException on a malformed cursor', () => {
    expect(() => decodeCursor('!!!not-base64!!!')).toThrow(BadRequestException);
    expect(() => decodeCursor(Buffer.from('-5').toString('base64url'))).toThrow(
      BadRequestException,
    );
    expect(() =>
      decodeCursor(Buffer.from('abc').toString('base64url')),
    ).toThrow(BadRequestException);
  });
});

// ── listMyGroups ─────────────────────────────────────────────────────────────

describe('StaffPortalService.listMyGroups', () => {
  it('returns groups with primary flag, age_range bounds, room and children_count', async () => {
    const h = build();
    h.groupRepo.groups.push(
      makeGroup({
        id: GROUP_A,
        kindergartenId: KG_A,
        name: 'Күншуақ',
        ageRangeMin: 4,
        ageRangeMax: 5,
        currentLocationId: LOCATION_A,
      }),
    );
    h.groupRepo.mentors.push(
      makeMentor({ kindergartenId: KG_A, groupId: GROUP_A, isPrimary: true }),
    );
    h.locationRepo.locations.push(
      Location.hydrate({
        id: LOCATION_A,
        kindergartenId: KG_A,
        name: 'Каб. 204',
        description: null,
        archivedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
    // 2 active children in the group, 1 archived (must not be counted).
    h.childRepo.children.push(
      makeChild({
        id: randomUUID(),
        kindergartenId: KG_A,
        currentGroupId: GROUP_A,
      }),
      makeChild({
        id: randomUUID(),
        kindergartenId: KG_A,
        currentGroupId: GROUP_A,
      }),
      makeChild({
        id: randomUUID(),
        kindergartenId: KG_A,
        currentGroupId: GROUP_A,
        status: 'archived',
      }),
    );

    const views = await h.service.listMyGroups(KG_A, MENTOR);

    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      id: GROUP_A,
      name: 'Күншуақ',
      ageRangeMin: 4,
      ageRangeMax: 5,
      room: 'Каб. 204',
      isPrimary: true,
      childrenCount: 2,
    });
  });

  it('returns null room when the group has no location', async () => {
    const h = build();
    h.groupRepo.groups.push(
      makeGroup({ id: GROUP_A, kindergartenId: KG_A, currentLocationId: null }),
    );
    h.groupRepo.mentors.push(
      makeMentor({ kindergartenId: KG_A, groupId: GROUP_A }),
    );

    const views = await h.service.listMyGroups(KG_A, MENTOR);

    expect(views[0].room).toBeNull();
    expect(views[0].isPrimary).toBe(false);
  });

  it('skips an assignment whose group no longer exists', async () => {
    const h = build();
    h.groupRepo.mentors.push(
      makeMentor({ kindergartenId: KG_A, groupId: GROUP_A }),
    );
    // no group seeded
    const views = await h.service.listMyGroups(KG_A, MENTOR);
    expect(views).toHaveLength(0);
  });
});

// ── listGroupRoster ──────────────────────────────────────────────────────────

describe('StaffPortalService.listGroupRoster', () => {
  function seedAssignedGroup(h: Harness): void {
    h.groupRepo.groups.push(makeGroup({ id: GROUP_A, kindergartenId: KG_A }));
    h.groupRepo.mentors.push(
      makeMentor({ kindergartenId: KG_A, groupId: GROUP_A }),
    );
  }

  it('returns only active children of the group with today day_status overlaid', async () => {
    const h = build();
    seedAssignedGroup(h);
    const c1 = randomUUID();
    const c2 = randomUUID();
    h.childRepo.children.push(
      makeChild({ id: c1, kindergartenId: KG_A, currentGroupId: GROUP_A }),
      makeChild({ id: c2, kindergartenId: KG_A, currentGroupId: GROUP_A }),
      // archived in group → excluded
      makeChild({
        id: randomUUID(),
        kindergartenId: KG_A,
        currentGroupId: GROUP_A,
        status: 'archived',
      }),
      // active but other group → excluded
      makeChild({
        id: randomUUID(),
        kindergartenId: KG_A,
        currentGroupId: GROUP_B,
      }),
    );
    h.dailyRepo.rows.push(
      makeDaily({
        kindergartenId: KG_A,
        childId: c1,
        date: '2026-06-24',
        status: ChildIntradayStatus.PRESENT,
      }),
    );

    const page = await h.service.listGroupRoster(KG_A, MENTOR, GROUP_A, {});

    expect(page.items).toHaveLength(2);
    const byId = new Map(page.items.map((i) => [i.child.id as string, i]));
    expect(byId.get(c1)!.dayStatus).toBe('present');
    expect(byId.get(c2)!.dayStatus).toBeNull();
    expect(page.nextCursor).toBeNull();
    // day_status query uses today as both bounds + the group filter
    expect(h.dailyRepo.lastFilter).toMatchObject({
      from: '2026-06-24',
      to: '2026-06-24',
      groupId: GROUP_A,
    });
  });

  it('returns a next_cursor on a full page and null on the last page', async () => {
    const h = build();
    seedAssignedGroup(h);
    for (let i = 0; i < 3; i++) {
      h.childRepo.children.push(
        makeChild({
          id: randomUUID(),
          kindergartenId: KG_A,
          currentGroupId: GROUP_A,
        }),
      );
    }

    const page1 = await h.service.listGroupRoster(KG_A, MENTOR, GROUP_A, {
      limit: 2,
    });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBe(encodeCursor(2));

    const page2 = await h.service.listGroupRoster(KG_A, MENTOR, GROUP_A, {
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
  });

  it('throws ForbiddenException when the caller is not assigned to the group', async () => {
    const h = build();
    h.groupRepo.groups.push(makeGroup({ id: GROUP_A, kindergartenId: KG_A }));
    // mentor assigned to a DIFFERENT group only
    h.groupRepo.mentors.push(
      makeMentor({ kindergartenId: KG_A, groupId: GROUP_B }),
    );

    await expect(
      h.service.listGroupRoster(KG_A, MENTOR, GROUP_A, {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('throws Forbidden for a kg_A mentor reading a kg_B group roster (cross-tenant phantom row)', async () => {
    const h = build();
    // Mentor actively assigned to GROUP_A in kg_A.
    h.groupRepo.groups.push(makeGroup({ id: GROUP_A, kindergartenId: KG_A }));
    h.groupRepo.mentors.push(
      makeMentor({ kindergartenId: KG_A, groupId: GROUP_A }),
    );
    // kg_B has its own group + children, invisible to a kg_A-scoped token.
    h.groupRepo.groups.push(makeGroup({ id: GROUP_B, kindergartenId: KG_B }));
    h.childRepo.children.push(
      makeChild({
        id: randomUUID(),
        kindergartenId: KG_B,
        currentGroupId: GROUP_B,
      }),
    );

    // Caller presents a kg_A token but asks for kg_B's group → assignment
    // lookup is kg_A-scoped, so GROUP_B is not in the assigned set → 403.
    await expect(
      h.service.listGroupRoster(KG_A, MENTOR, GROUP_B, {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

// ── listSpecialistChildren ───────────────────────────────────────────────────

describe('StaffPortalService.listSpecialistChildren', () => {
  it('returns all active children of the kg, paginated by opaque cursor', async () => {
    const h = build();
    for (let i = 0; i < 3; i++) {
      h.childRepo.children.push(
        makeChild({
          id: randomUUID(),
          kindergartenId: KG_A,
          currentGroupId: GROUP_A,
        }),
      );
    }
    // archived child must be excluded
    h.childRepo.children.push(
      makeChild({ id: randomUUID(), kindergartenId: KG_A, status: 'archived' }),
    );
    // child in another kg must be excluded
    h.childRepo.children.push(
      makeChild({ id: randomUUID(), kindergartenId: KG_B }),
    );

    const page1 = await h.service.listSpecialistChildren(KG_A, { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toBe(encodeCursor(2));

    const page2 = await h.service.listSpecialistChildren(KG_A, {
      limit: 2,
      cursor: page1.nextCursor!,
    });
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
  });
});

// ── getChildCard ─────────────────────────────────────────────────────────────

describe('StaffPortalService.getChildCard', () => {
  it('wraps allergy_notes into a single-element array and overlays group_name + guardians', async () => {
    const h = build();
    const childId = randomUUID();
    const primaryUser = 'aaaaaaaa-2222-2222-2222-aaaaaaaaaaaa';
    h.groupRepo.groups.push(
      makeGroup({ id: GROUP_A, kindergartenId: KG_A, name: 'Күншуақ' }),
    );
    h.childRepo.children.push(
      makeChild({
        id: childId,
        kindergartenId: KG_A,
        currentGroupId: GROUP_A,
        allergyNotes: 'Орехи',
        medicalNotes: 'Поллиноз весной',
      }),
    );
    h.guardianRepo.guardians.push(
      makeGuardian({
        kindergartenId: KG_A,
        childId,
        userId: primaryUser,
        role: 'primary',
        status: 'approved',
        canPickup: true,
      }),
      // revoked guardian must be filtered out
      makeGuardian({
        kindergartenId: KG_A,
        childId,
        userId: 'aaaaaaaa-3333-3333-3333-aaaaaaaaaaaa',
        role: 'secondary',
        status: 'revoked',
      }),
    );
    h.identities.set(primaryUser, {
      fullName: 'Айгүл Серикова',
      phone: '+77011234567',
    });

    const view = await h.service.getChildCard(KG_A, childId);

    expect(view.groupName).toBe('Күншуақ');
    expect(view.child.toState().allergyNotes).toBe('Орехи');
    expect(view.child.toState().medicalNotes).toBe('Поллиноз весной');
    expect(view.guardians).toHaveLength(1);
    expect(view.guardians[0]).toMatchObject({
      fullName: 'Айгүл Серикова',
      phone: '+77011234567',
    });
    expect(
      view.guardians[0].guardian.role.equals(GuardianRelation.PRIMARY),
    ).toBe(true);
    expect(view.guardians[0].guardian.canPickup).toBe(true);
  });

  it('returns an empty allergies array when allergy_notes is null', async () => {
    const h = build();
    const childId = randomUUID();
    h.childRepo.children.push(
      makeChild({ id: childId, kindergartenId: KG_A, allergyNotes: null }),
    );
    const view = await h.service.getChildCard(KG_A, childId);
    expect(view.child.toState().allergyNotes).toBeNull();
    expect(view.guardians).toHaveLength(0);
  });

  it('throws ChildNotFoundError for a child in another kg (cross-tenant)', async () => {
    const h = build();
    const childId = randomUUID();
    h.childRepo.children.push(makeChild({ id: childId, kindergartenId: KG_B }));
    await expect(h.service.getChildCard(KG_A, childId)).rejects.toBeInstanceOf(
      ChildNotFoundError,
    );
  });
});

// ── presenter ────────────────────────────────────────────────────────────────

describe('StaffPortalPresenter', () => {
  it('formats age_range from bounds', () => {
    expect(formatAgeRange(4, 5)).toBe('4–5 лет');
    expect(formatAgeRange(4, null)).toBe('4+ лет');
    expect(formatAgeRange(null, null)).toBeNull();
    expect(formatAgeRange(null, 5)).toBeNull();
  });

  it('wraps a non-null allergy note into a single-element array', () => {
    const dto = StaffPortalPresenter.childCard({
      child: makeChild({
        id: randomUUID(),
        kindergartenId: KG_A,
        allergyNotes: 'Орехи',
      }),
      groupName: 'Күншуақ',
      guardians: [],
    });
    expect(dto.allergies).toEqual(['Орехи']);
    expect(dto.group_name).toBe('Күншуақ');
  });

  it('returns an empty allergies array when the allergy note is null', () => {
    const dto = StaffPortalPresenter.childCard({
      child: makeChild({
        id: randomUUID(),
        kindergartenId: KG_A,
        allergyNotes: null,
      }),
      groupName: null,
      guardians: [],
    });
    expect(dto.allergies).toEqual([]);
  });

  it('maps a guardian to snake_case with relation = role', () => {
    const userId = 'aaaaaaaa-2222-2222-2222-aaaaaaaaaaaa';
    const dto = StaffPortalPresenter.childCard({
      child: makeChild({ id: randomUUID(), kindergartenId: KG_A }),
      groupName: null,
      guardians: [
        {
          guardian: makeGuardian({
            kindergartenId: KG_A,
            childId: randomUUID(),
            userId,
            role: 'nanny',
            canPickup: false,
          }),
          fullName: 'Няня Ивановна',
          phone: '+77019998877',
        },
      ],
    });
    expect(dto.guardians[0]).toEqual({
      user_id: userId,
      full_name: 'Няня Ивановна',
      relation: 'nanny',
      phone: '+77019998877',
      can_pickup: false,
    });
  });
});
