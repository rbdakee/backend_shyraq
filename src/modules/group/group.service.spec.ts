import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { InvariantViolationError } from '@/shared-kernel/domain/errors';
import { Location } from '@/modules/location/domain/entities/location.entity';
import { LocationNotFoundError } from '@/modules/location/domain/errors/location-not-found.error';
import {
  CreateLocationInput,
  ListLocationsFilters,
  LocationRepository,
  UpdateLocationInput,
} from '@/modules/location/infrastructure/persistence/location.repository';
import { StaffMember } from '@/modules/staff/domain/entities/staff-member.entity';
import { StaffNotFoundError } from '@/modules/staff/domain/errors/staff-not-found.error';
import {
  CreateStaffMemberInput,
  ListStaffFilters,
  StaffMemberRepository,
  UpdateStaffMemberInput,
} from '@/modules/staff/infrastructure/persistence/staff-member.repository';
import { Group } from './domain/entities/group.entity';
import { GroupMentor } from './domain/entities/group-mentor.entity';
import { GroupArchivedError } from './domain/errors/group-archived.error';
import { GroupNotFoundError } from './domain/errors/group-not-found.error';
import { MentorNotEligibleError } from './domain/errors/mentor-not-eligible.error';
import {
  CreateGroupInput,
  GroupRepository,
  ListGroupsFilters,
  UpdateGroupInput,
} from './infrastructure/persistence/group.repository';
import { GroupService } from './group.service';

// ── fakes ──────────────────────────────────────────────────────────────────

class FakeClock implements ClockPort {
  constructor(private readonly fixed: Date) {}
  now(): Date {
    return this.fixed;
  }
}

class FakeGroupRepo extends GroupRepository {
  groups = new Map<string, Group>();
  // group_mentors: rolling list across all groups
  mentors: GroupMentor[] = [];
  private nextId = 1;
  private nextMentorId = 1;

  putGroup(g: Group): void {
    this.groups.set(g.id, g);
  }

  create(kindergartenId: string, input: CreateGroupInput): Promise<Group> {
    const id = `g-${this.nextId++}`;
    const now = new Date('2026-04-28T12:00:00.000Z');
    const g = Group.hydrate({
      id,
      kindergartenId,
      name: input.name,
      capacity: input.capacity,
      ageRangeMin: input.ageRangeMin ?? null,
      ageRangeMax: input.ageRangeMax ?? null,
      currentLocationId: input.currentLocationId ?? null,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    this.putGroup(g);
    return Promise.resolve(g);
  }

  findById(kindergartenId: string, id: string): Promise<Group | null> {
    const g = this.groups.get(id);
    if (!g || g.kindergartenId !== kindergartenId) return Promise.resolve(null);
    return Promise.resolve(g);
  }

  list(kindergartenId: string, filters?: ListGroupsFilters): Promise<Group[]> {
    let items = [...this.groups.values()].filter(
      (g) => g.kindergartenId === kindergartenId,
    );
    if (filters?.archived === true) {
      items = items.filter((g) => g.isArchived);
    } else if (filters?.archived === false) {
      items = items.filter((g) => !g.isArchived);
    }
    return Promise.resolve(items);
  }

  update(
    kindergartenId: string,
    id: string,
    patch: UpdateGroupInput,
  ): Promise<Group | null> {
    const current = this.groups.get(id);
    if (!current || current.kindergartenId !== kindergartenId) {
      return Promise.resolve(null);
    }
    const s = current.toState();
    const now = new Date('2026-04-28T12:30:00.000Z');
    const next = Group.hydrate({
      ...s,
      name: patch.name ?? s.name,
      capacity: patch.capacity ?? s.capacity,
      ageRangeMin:
        patch.ageRangeMin !== undefined ? patch.ageRangeMin : s.ageRangeMin,
      ageRangeMax:
        patch.ageRangeMax !== undefined ? patch.ageRangeMax : s.ageRangeMax,
      currentLocationId:
        patch.currentLocationId !== undefined
          ? patch.currentLocationId
          : s.currentLocationId,
      updatedAt: now,
    });
    this.groups.set(id, next);
    return Promise.resolve(next);
  }

  save(group: Group): Promise<Group> {
    this.groups.set(group.id, group);
    return Promise.resolve(group);
  }

  // ── mentors ────────────────────────────────────────────────────────────

  assignMentor(
    kindergartenId: string,
    groupId: string,
    staffMemberId: string,
    now: Date,
  ): Promise<GroupMentor> {
    // Close active row(s) — semantic of the real repo's same-TX behaviour.
    for (let i = 0; i < this.mentors.length; i++) {
      const m = this.mentors[i];
      if (
        m.kindergartenId === kindergartenId &&
        m.groupId === groupId &&
        m.unassignedAt === null
      ) {
        const closed = GroupMentor.hydrate({
          ...m.toState(),
          unassignedAt: now,
        });
        this.mentors[i] = closed;
      }
    }
    const fresh = GroupMentor.hydrate({
      id: `m-${this.nextMentorId++}`,
      kindergartenId,
      groupId,
      staffMemberId,
      isPrimary: true,
      assignedAt: now,
      unassignedAt: null,
      createdAt: now,
    });
    this.mentors.push(fresh);
    return Promise.resolve(fresh);
  }

  unassignMentor(
    kindergartenId: string,
    groupId: string,
    now: Date,
  ): Promise<GroupMentor | null> {
    const idx = this.mentors.findIndex(
      (m) =>
        m.kindergartenId === kindergartenId &&
        m.groupId === groupId &&
        m.unassignedAt === null,
    );
    if (idx < 0) return Promise.resolve(null);
    const closed = GroupMentor.hydrate({
      ...this.mentors[idx].toState(),
      unassignedAt: now,
    });
    this.mentors[idx] = closed;
    return Promise.resolve(closed);
  }

  findActiveMentor(
    kindergartenId: string,
    groupId: string,
  ): Promise<GroupMentor | null> {
    const found =
      this.mentors.find(
        (m) =>
          m.kindergartenId === kindergartenId &&
          m.groupId === groupId &&
          m.unassignedAt === null,
      ) ?? null;
    return Promise.resolve(found);
  }

  listMentorHistory(
    kindergartenId: string,
    groupId: string,
  ): Promise<GroupMentor[]> {
    const items = this.mentors
      .filter(
        (m) => m.kindergartenId === kindergartenId && m.groupId === groupId,
      )
      .sort((a, b) => b.assignedAt.getTime() - a.assignedAt.getTime());
    return Promise.resolve(items);
  }
}

class FakeLocationRepo extends LocationRepository {
  byId = new Map<string, Location>();

  put(loc: Location): void {
    this.byId.set(loc.id, loc);
  }

  create(_kg: string, _input: CreateLocationInput): Promise<Location> {
    throw new Error('not used');
  }
  findById(kg: string, id: string): Promise<Location | null> {
    const loc = this.byId.get(id);
    if (!loc || loc.kindergartenId !== kg) return Promise.resolve(null);
    return Promise.resolve(loc);
  }
  list(_kg: string, _filters?: ListLocationsFilters): Promise<Location[]> {
    return Promise.resolve([]);
  }
  update(
    _kg: string,
    _id: string,
    _patch: UpdateLocationInput,
  ): Promise<Location | null> {
    throw new Error('not used');
  }
  save(loc: Location): Promise<Location> {
    this.byId.set(loc.id, loc);
    return Promise.resolve(loc);
  }
}

class FakeStaffRepo extends StaffMemberRepository {
  byId = new Map<string, StaffMember>();

  put(staff: StaffMember): void {
    this.byId.set(staff.id, staff);
  }

  create(_input: CreateStaffMemberInput): Promise<StaffMember> {
    throw new Error('not used');
  }
  findById(kg: string, id: string): Promise<StaffMember | null> {
    const s = this.byId.get(id);
    if (!s || s.kindergartenId !== kg) return Promise.resolve(null);
    return Promise.resolve(s);
  }
  findActiveByUserAndKindergarten(
    _userId: string,
    _kindergartenId: string,
  ): Promise<StaffMember | null> {
    return Promise.resolve(null);
  }
  listByKindergarten(
    kg: string,
    _filters?: ListStaffFilters,
  ): Promise<StaffMember[]> {
    return Promise.resolve(
      [...this.byId.values()].filter((s) => s.kindergartenId === kg),
    );
  }
  update(
    _kg: string,
    _id: string,
    _patch: UpdateStaffMemberInput,
  ): Promise<StaffMember | null> {
    throw new Error('not used');
  }
  save(staff: StaffMember): Promise<StaffMember> {
    this.byId.set(staff.id, staff);
    return Promise.resolve(staff);
  }
  deactivateAllByKindergarten(_kg: string, _now: Date): Promise<number> {
    return Promise.resolve(0);
  }
  findAllActiveByUserId(userId: string): Promise<StaffMember[]> {
    return Promise.resolve(
      [...this.byId.values()].filter((s) => s.userId === userId && s.isActive),
    );
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

const KG = 'kg-A';
const T0 = new Date('2026-04-28T10:00:00.000Z');

function aLocation(id: string, kg = KG): Location {
  return Location.hydrate({
    id,
    kindergartenId: kg,
    name: `loc ${id}`,
    description: null,
    archivedAt: null,
    createdAt: T0,
    updatedAt: T0,
  });
}

function aStaff(
  id: string,
  opts: Partial<{
    kg: string;
    isActive: boolean;
    archivedAt: Date | null;
  }> = {},
): StaffMember {
  return StaffMember.hydrate({
    id,
    kindergartenId: opts.kg ?? KG,
    userId: `u-${id}`,
    fullName: `Name ${id}`,
    phone: '+77011111111',
    role: 'mentor',
    specialistType: null,
    isActive: opts.isActive ?? true,
    hiredAt: T0,
    firedAt: null,
    archivedAt: opts.archivedAt ?? null,
    createdAt: T0,
    updatedAt: T0,
  });
}

function makeService(now = T0) {
  const groups = new FakeGroupRepo();
  const locations = new FakeLocationRepo();
  const staff = new FakeStaffRepo();
  const clock = new FakeClock(now);
  const service = new GroupService(groups, locations, staff, clock);
  return { service, groups, locations, staff, clock };
}

// ── tests ──────────────────────────────────────────────────────────────────

describe('GroupService', () => {
  describe('create', () => {
    it('creates a group with valid inputs', async () => {
      const { service } = makeService();
      const g = await service.create(KG, {
        name: 'Sunflowers',
        capacity: 20,
        ageRangeMin: 3,
        ageRangeMax: 5,
      });
      expect(g.name).toBe('Sunflowers');
      expect(g.capacity).toBe(20);
    });

    it('rejects non-positive capacity', async () => {
      const { service } = makeService();
      await expect(
        service.create(KG, { name: 'X', capacity: 0 }),
      ).rejects.toBeInstanceOf(InvariantViolationError);
    });

    it('rejects inverted age range', async () => {
      const { service } = makeService();
      await expect(
        service.create(KG, {
          name: 'X',
          capacity: 5,
          ageRangeMin: 5,
          ageRangeMax: 3,
        }),
      ).rejects.toBeInstanceOf(InvariantViolationError);
    });

    it('rejects unknown current_location_id', async () => {
      const { service } = makeService();
      await expect(
        service.create(KG, {
          name: 'X',
          capacity: 5,
          currentLocationId: 'no-such-loc',
        }),
      ).rejects.toBeInstanceOf(LocationNotFoundError);
    });

    it('accepts a valid location', async () => {
      const { service, locations } = makeService();
      locations.put(aLocation('loc-1'));
      const g = await service.create(KG, {
        name: 'X',
        capacity: 5,
        currentLocationId: 'loc-1',
      });
      expect(g.currentLocationId).toBe('loc-1');
    });
  });

  describe('update', () => {
    it('refuses to update an archived group', async () => {
      const { service, groups, clock } = makeService();
      const g = await service.create(KG, { name: 'A', capacity: 10 });
      g.archive(clock.now());
      groups.putGroup(g);
      await expect(
        service.update(KG, g.id, { name: 'B' }),
      ).rejects.toBeInstanceOf(GroupArchivedError);
    });

    it('rejects merged invalid age range', async () => {
      const { service } = makeService();
      const g = await service.create(KG, {
        name: 'A',
        capacity: 10,
        ageRangeMin: 2,
        ageRangeMax: 5,
      });
      await expect(
        service.update(KG, g.id, { ageRangeMin: 6 }),
      ).rejects.toBeInstanceOf(InvariantViolationError);
    });

    it('clears location when current_location_id=null', async () => {
      const { service, locations } = makeService();
      locations.put(aLocation('loc-1'));
      const g = await service.create(KG, {
        name: 'A',
        capacity: 10,
        currentLocationId: 'loc-1',
      });
      const updated = await service.update(KG, g.id, {
        currentLocationId: null,
      });
      expect(updated.currentLocationId).toBeNull();
    });
  });

  describe('archive / restore', () => {
    it('is idempotent both ways', async () => {
      const { service } = makeService();
      const g = await service.create(KG, { name: 'A', capacity: 10 });
      const a1 = await service.archive(KG, g.id);
      const a2 = await service.archive(KG, g.id);
      expect(a1.isArchived).toBe(true);
      expect(a2.isArchived).toBe(true);
      const r1 = await service.restore(KG, g.id);
      const r2 = await service.restore(KG, g.id);
      expect(r1.isArchived).toBe(false);
      expect(r2.isArchived).toBe(false);
    });

    it('throws when group does not exist', async () => {
      const { service } = makeService();
      await expect(service.archive(KG, 'no-such')).rejects.toBeInstanceOf(
        GroupNotFoundError,
      );
    });
  });

  describe('assignMentor — rich-aggregate invariant', () => {
    it('refuses unknown group', async () => {
      const { service, staff } = makeService();
      staff.put(aStaff('s-1'));
      await expect(
        service.assignMentor(KG, 'no-such', 's-1'),
      ).rejects.toBeInstanceOf(GroupNotFoundError);
    });

    it('refuses an archived group', async () => {
      const { service, staff, clock } = makeService();
      staff.put(aStaff('s-1'));
      const g = await service.create(KG, { name: 'A', capacity: 10 });
      g.archive(clock.now());
      await expect(
        service.assignMentor(KG, g.id, 's-1'),
      ).rejects.toBeInstanceOf(GroupArchivedError);
    });

    it('refuses unknown staff_member', async () => {
      const { service } = makeService();
      const g = await service.create(KG, { name: 'A', capacity: 10 });
      await expect(
        service.assignMentor(KG, g.id, 'no-such'),
      ).rejects.toBeInstanceOf(StaffNotFoundError);
    });

    it('refuses an inactive staff_member', async () => {
      const { service, staff } = makeService();
      staff.put(aStaff('s-1', { isActive: false }));
      const g = await service.create(KG, { name: 'A', capacity: 10 });
      await expect(
        service.assignMentor(KG, g.id, 's-1'),
      ).rejects.toBeInstanceOf(MentorNotEligibleError);
    });

    it('refuses an archived staff_member', async () => {
      const { service, staff } = makeService();
      staff.put(aStaff('s-1', { archivedAt: T0 }));
      const g = await service.create(KG, { name: 'A', capacity: 10 });
      await expect(
        service.assignMentor(KG, g.id, 's-1'),
      ).rejects.toBeInstanceOf(MentorNotEligibleError);
    });

    it('on first assign creates one active row', async () => {
      const { service, staff, groups } = makeService();
      staff.put(aStaff('s-1'));
      const g = await service.create(KG, { name: 'A', capacity: 10 });
      const m = await service.assignMentor(KG, g.id, 's-1');
      expect(m.isActive).toBe(true);
      expect(
        groups.mentors.filter((x) => x.unassignedAt === null),
      ).toHaveLength(1);
    });

    /**
     * Critical invariant: assigning a second mentor in a row must close the
     * previous active row (set unassigned_at = now) before inserting the new
     * one. Aft the call, exactly one active row exists for the group, the
     * previous mentor row is closed at the same `now`, and history reflects
     * both rows in DESC order by assigned_at.
     */
    it('second assign closes the previous active row and adds a new active row', async () => {
      const { service, staff, groups, clock } = makeService();
      staff.put(aStaff('s-1'));
      staff.put(aStaff('s-2'));
      const g = await service.create(KG, { name: 'A', capacity: 10 });

      const first = await service.assignMentor(KG, g.id, 's-1');
      const second = await service.assignMentor(KG, g.id, 's-2');

      expect(first.staffMemberId).toBe('s-1');
      expect(second.staffMemberId).toBe('s-2');

      const active = groups.mentors.filter((m) => m.unassignedAt === null);
      expect(active).toHaveLength(1);
      expect(active[0].staffMemberId).toBe('s-2');

      const closed = groups.mentors.filter((m) => m.unassignedAt !== null);
      expect(closed).toHaveLength(1);
      expect(closed[0].staffMemberId).toBe('s-1');
      expect(closed[0].unassignedAt).toEqual(clock.now());

      const history = await service.getMentorHistory(KG, g.id);
      expect(history).toHaveLength(2);
      // DESC by assigned_at — both share the fixed clock so order may match
      // insertion; test the membership rather than ordering instability.
      const ids = history.map((m) => m.staffMemberId).sort();
      expect(ids).toEqual(['s-1', 's-2']);
    });
  });

  describe('unassignMentor', () => {
    it('returns null when nothing is active (idempotent)', async () => {
      const { service } = makeService();
      const g = await service.create(KG, { name: 'A', capacity: 10 });
      await expect(service.unassignMentor(KG, g.id)).resolves.toBeNull();
    });

    it('closes the active row when one exists', async () => {
      const { service, staff, groups } = makeService();
      staff.put(aStaff('s-1'));
      const g = await service.create(KG, { name: 'A', capacity: 10 });
      await service.assignMentor(KG, g.id, 's-1');
      const closed = await service.unassignMentor(KG, g.id);
      expect(closed).not.toBeNull();
      expect(closed!.unassignedAt).not.toBeNull();
      const active = groups.mentors.filter((m) => m.unassignedAt === null);
      expect(active).toHaveLength(0);
    });
  });

  describe('mentor reads', () => {
    it('getActiveMentor returns the active row or null', async () => {
      const { service, staff } = makeService();
      staff.put(aStaff('s-1'));
      const g = await service.create(KG, { name: 'A', capacity: 10 });
      await expect(service.getActiveMentor(KG, g.id)).resolves.toBeNull();
      await service.assignMentor(KG, g.id, 's-1');
      const m = await service.getActiveMentor(KG, g.id);
      expect(m?.staffMemberId).toBe('s-1');
    });

    it('getMentorHistory returns all rows including closed', async () => {
      const { service, staff } = makeService();
      staff.put(aStaff('s-1'));
      staff.put(aStaff('s-2'));
      const g = await service.create(KG, { name: 'A', capacity: 10 });
      await service.assignMentor(KG, g.id, 's-1');
      await service.assignMentor(KG, g.id, 's-2');
      const hist = await service.getMentorHistory(KG, g.id);
      expect(hist).toHaveLength(2);
    });
  });

  describe('cross-tenant guard rails', () => {
    it('does not return groups from a different kindergarten', async () => {
      const { service, groups } = makeService();
      // Plant a group in another kindergarten.
      const otherKg = 'kg-B';
      const other = Group.hydrate({
        id: 'g-other',
        kindergartenId: otherKg,
        name: 'other',
        capacity: 5,
        ageRangeMin: null,
        ageRangeMax: null,
        currentLocationId: null,
        archivedAt: null,
        createdAt: T0,
        updatedAt: T0,
      });
      groups.putGroup(other);
      await expect(service.getById(KG, 'g-other')).rejects.toBeInstanceOf(
        GroupNotFoundError,
      );
    });
  });
});
