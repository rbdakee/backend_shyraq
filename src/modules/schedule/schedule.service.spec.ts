/**
 * ScheduleService — service-unit suite. All collaborators are hand-written
 * in-memory fakes (no Jest auto-mock). Exercises the happy paths, the
 * activity_event state machine, listEvents filters, idempotent
 * `copyWeekToNext`, and parent-side group resolution.
 */
import { Child } from '@/modules/child/domain/entities/child.entity';
import { ChildNotFoundError } from '@/modules/child/domain/errors/child-not-found.error';
import {
  ChildGroupHistoryRecord,
  ChildListFilters,
  ChildRepository,
  PageRequest,
  PageResult,
} from '@/modules/child/infrastructure/persistence/child.repository';
import { Group } from '@/modules/group/domain/entities/group.entity';
import { GroupMentor } from '@/modules/group/domain/entities/group-mentor.entity';
import { GroupNotFoundError } from '@/modules/group/domain/errors/group-not-found.error';
import {
  CreateGroupInput,
  GroupRepository,
  ListGroupsFilters,
  UpdateGroupInput,
} from '@/modules/group/infrastructure/persistence/group.repository';
import { Location } from '@/modules/location/domain/entities/location.entity';
import {
  CreateLocationInput,
  ListLocationsFilters,
  LocationRepository,
  UpdateLocationInput,
} from '@/modules/location/infrastructure/persistence/location.repository';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { ActivityEvent } from './domain/entities/activity-event.entity';
import { ActivityEventStatusValue } from './domain/value-objects/activity-event-status.vo';
import { ScheduleTemplate } from './domain/entities/schedule-template.entity';
import { ScheduleWeekSnapshot } from './domain/entities/schedule-week-snapshot.entity';
import { ActivityEventNotFoundError } from './domain/errors/activity-event-not-found.error';
import { EventNotDeletableError } from './domain/errors/event-not-deletable.error';
import { EventTransitionConflictError } from './domain/errors/event-transition-conflict.error';
import { InvalidEventTransitionError } from './domain/errors/invalid-event-transition.error';
import { ScheduleTemplateNotFoundError } from './domain/errors/schedule-template-not-found.error';
import { SlotConflictError } from './domain/errors/slot-conflict.error';
import {
  ActivityEventRepository,
  ListActivityEventsFilter,
} from './infrastructure/persistence/activity-event.repository';
import {
  ListScheduleTemplatesFilter,
  ScheduleTemplateRepository,
} from './infrastructure/persistence/schedule-template.repository';
import {
  ListScheduleWeekSnapshotsFilter,
  ScheduleWeekSnapshotRepository,
} from './infrastructure/persistence/schedule-week-snapshot.repository';
import { ScheduleService } from './schedule.service';

// ── Constants ────────────────────────────────────────────────────────────

const KG = '11111111-1111-1111-1111-111111111111';
const KG_OTHER = '99999999-9999-9999-9999-999999999999';
const GROUP_A = '22222222-2222-2222-2222-222222222222';
const GROUP_B = '33333333-3333-3333-3333-333333333333';
const CHILD_A = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const LOCATION_A = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const LOCATION_B = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
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

function cloneTemplate(t: ScheduleTemplate): ScheduleTemplate {
  return ScheduleTemplate.hydrate(t.toState());
}

function cloneEvent(e: ActivityEvent): ActivityEvent {
  return ActivityEvent.hydrate(e.toState());
}

class FakeScheduleTemplateRepo extends ScheduleTemplateRepository {
  rows = new Map<string, ScheduleTemplate>();

  put(t: ScheduleTemplate): void {
    this.rows.set(t.id, cloneTemplate(t));
  }

  create(kg: string, t: ScheduleTemplate): Promise<ScheduleTemplate> {
    if (t.kindergartenId !== kg) throw new Error('kg mismatch');
    this.rows.set(t.id, cloneTemplate(t));
    return Promise.resolve(cloneTemplate(t));
  }
  findById(kg: string, id: string): Promise<ScheduleTemplate | null> {
    const t = this.rows.get(id);
    if (!t || t.kindergartenId !== kg) return Promise.resolve(null);
    return Promise.resolve(cloneTemplate(t));
  }
  list(
    kg: string,
    filter: ListScheduleTemplatesFilter,
  ): Promise<ScheduleTemplate[]> {
    let items = [...this.rows.values()].filter((t) => t.kindergartenId === kg);
    if (filter.groupId !== undefined) {
      items = items.filter((t) => t.groupId === filter.groupId);
    }
    if (filter.isActive !== undefined) {
      items = items.filter((t) => t.isActive === filter.isActive);
    }
    return Promise.resolve(items.map((t) => cloneTemplate(t)));
  }
  listActiveValidOn(kg: string, date: Date): Promise<ScheduleTemplate[]> {
    const items = [...this.rows.values()].filter(
      (t) =>
        t.kindergartenId === kg &&
        t.isActive &&
        t.validFrom.getTime() <= date.getTime() &&
        (t.validUntil === null || t.validUntil.getTime() >= date.getTime()),
    );
    return Promise.resolve(items.map((t) => cloneTemplate(t)));
  }
  save(kg: string, t: ScheduleTemplate): Promise<ScheduleTemplate> {
    if (t.kindergartenId !== kg) throw new Error('kg mismatch');
    this.rows.set(t.id, cloneTemplate(t));
    return Promise.resolve(cloneTemplate(t));
  }
  delete(kg: string, id: string): Promise<void> {
    const t = this.rows.get(id);
    if (t && t.kindergartenId === kg) this.rows.delete(id);
    return Promise.resolve();
  }
}

class FakeActivityEventRepo extends ActivityEventRepository {
  rows = new Map<string, ActivityEvent>();

  put(e: ActivityEvent): void {
    this.rows.set(e.id, cloneEvent(e));
  }

  create(kg: string, e: ActivityEvent): Promise<ActivityEvent> {
    if (e.kindergartenId !== kg) throw new Error('kg mismatch');
    this.rows.set(e.id, cloneEvent(e));
    return Promise.resolve(cloneEvent(e));
  }
  createMany(kg: string, events: ActivityEvent[]): Promise<ActivityEvent[]> {
    for (const e of events) {
      if (e.kindergartenId !== kg) throw new Error('kg mismatch');
      this.rows.set(e.id, cloneEvent(e));
    }
    return Promise.resolve(events.map((e) => cloneEvent(e)));
  }
  findById(kg: string, id: string): Promise<ActivityEvent | null> {
    const e = this.rows.get(id);
    if (!e || e.kindergartenId !== kg) return Promise.resolve(null);
    return Promise.resolve(cloneEvent(e));
  }
  update(kg: string, e: ActivityEvent): Promise<ActivityEvent> {
    if (!this.rows.has(e.id)) throw new Error('row missing');
    if (e.kindergartenId !== kg) throw new Error('kg mismatch');
    this.rows.set(e.id, cloneEvent(e));
    return Promise.resolve(cloneEvent(e));
  }
  updateWithExpectedStatus(
    kg: string,
    e: ActivityEvent,
    expectedOldStatus: ActivityEventStatusValue,
  ): Promise<boolean> {
    const current = this.rows.get(e.id);
    if (!current || current.kindergartenId !== kg)
      return Promise.resolve(false);
    if (current.status.value !== expectedOldStatus) {
      // Race: another caller already moved this row off the expected status.
      return Promise.resolve(false);
    }
    this.rows.set(e.id, cloneEvent(e));
    return Promise.resolve(true);
  }
  list(kg: string, filter: ListActivityEventsFilter): Promise<ActivityEvent[]> {
    let items = [...this.rows.values()].filter((e) => e.kindergartenId === kg);
    if (filter.groupId !== undefined) {
      items = items.filter((e) => e.groupId === filter.groupId);
    }
    if (filter.from !== undefined) {
      items = items.filter(
        (e) => e.startsAt.getTime() >= filter.from!.getTime(),
      );
    }
    if (filter.to !== undefined) {
      items = items.filter((e) => e.startsAt.getTime() < filter.to!.getTime());
    }
    if (filter.status !== undefined) {
      items = items.filter((e) => e.status.value === filter.status);
    }
    items.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
    return Promise.resolve(items.map((e) => cloneEvent(e)));
  }
  delete(kg: string, id: string): Promise<void> {
    const e = this.rows.get(id);
    if (e && e.kindergartenId === kg) this.rows.delete(id);
    return Promise.resolve();
  }
  /**
   * Mirrors the single DELETE of the relational impl, predicate for predicate:
   * tenant + group + origin='template' + status='scheduled' + starts_at in
   * [from, to) + starts_at > after.
   */
  deleteTemplateScheduledInRange(
    kg: string,
    groupId: string,
    from: Date,
    to: Date,
    after: Date,
  ): Promise<number> {
    let deleted = 0;
    for (const [id, e] of [...this.rows]) {
      if (
        e.kindergartenId === kg &&
        e.groupId === groupId &&
        e.origin === 'template' &&
        e.status.value === 'scheduled' &&
        e.startsAt.getTime() >= from.getTime() &&
        e.startsAt.getTime() < to.getTime() &&
        e.startsAt.getTime() > after.getTime()
      ) {
        this.rows.delete(id);
        deleted += 1;
      }
    }
    return Promise.resolve(deleted);
  }
}

class FakeWeekSnapshotRepo extends ScheduleWeekSnapshotRepository {
  rows: ScheduleWeekSnapshot[] = [];

  create(
    kg: string,
    snapshot: ScheduleWeekSnapshot,
  ): Promise<ScheduleWeekSnapshot> {
    if (snapshot.kindergartenId !== kg) throw new Error('kg mismatch');
    this.rows.push(snapshot);
    return Promise.resolve(snapshot);
  }
  tryCreate(
    kg: string,
    snapshot: ScheduleWeekSnapshot,
  ): Promise<ScheduleWeekSnapshot | null> {
    if (snapshot.kindergartenId !== kg) throw new Error('kg mismatch');
    const existing = this.rows.find(
      (r) =>
        r.kindergartenId === kg &&
        r.groupId === snapshot.groupId &&
        r.weekStartDate.getTime() === snapshot.weekStartDate.getTime(),
    );
    if (existing) return Promise.resolve(null);
    this.rows.push(snapshot);
    return Promise.resolve(snapshot);
  }
  findByGroupAndWeek(
    kg: string,
    groupId: string,
    week: Date,
  ): Promise<ScheduleWeekSnapshot | null> {
    const found =
      this.rows.find(
        (r) =>
          r.kindergartenId === kg &&
          r.groupId === groupId &&
          r.weekStartDate.getTime() === week.getTime(),
      ) ?? null;
    return Promise.resolve(found);
  }
  list(
    kg: string,
    filter: ListScheduleWeekSnapshotsFilter,
  ): Promise<ScheduleWeekSnapshot[]> {
    let items = this.rows.filter((r) => r.kindergartenId === kg);
    if (filter.groupId !== undefined) {
      items = items.filter((r) => r.groupId === filter.groupId);
    }
    // Bounds mirror the relational impl: `from` inclusive, `to` INCLUSIVE
    // (week_start_date >= :from / <= :to).
    if (filter.from !== undefined) {
      items = items.filter(
        (r) => r.weekStartDate.getTime() >= filter.from!.getTime(),
      );
    }
    if (filter.to !== undefined) {
      items = items.filter(
        (r) => r.weekStartDate.getTime() <= filter.to!.getTime(),
      );
    }
    return Promise.resolve(items);
  }
}

class FakeGroupRepo extends GroupRepository {
  byId = new Map<string, Group>();

  put(g: Group): void {
    this.byId.set(g.id, g);
  }
  create(_kg: string, _input: CreateGroupInput): Promise<Group> {
    throw new Error('not used');
  }
  findById(kg: string, id: string): Promise<Group | null> {
    const g = this.byId.get(id);
    if (!g || g.kindergartenId !== kg) return Promise.resolve(null);
    return Promise.resolve(g);
  }
  list(kg: string, _filters?: ListGroupsFilters): Promise<Group[]> {
    return Promise.resolve(
      [...this.byId.values()].filter((g) => g.kindergartenId === kg),
    );
  }
  update(
    _kg: string,
    _id: string,
    _patch: UpdateGroupInput,
  ): Promise<Group | null> {
    throw new Error('not used');
  }
  save(g: Group): Promise<Group> {
    this.byId.set(g.id, g);
    return Promise.resolve(g);
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
    _kg: string,
    _sid: string,
    _now: Date,
  ): Promise<number> {
    throw new Error('not used');
  }
  findActiveMentor(_kg: string, _gid: string): Promise<GroupMentor | null> {
    throw new Error('not used');
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

class FakeChildRepo extends ChildRepository {
  byId = new Map<string, Child>();

  put(c: Child): void {
    this.byId.set(c.id as unknown as string, c);
  }

  create(_c: Child): Promise<void> {
    throw new Error('not used');
  }
  findById(kg: string, id: string): Promise<Child | null> {
    const c = this.byId.get(id);
    if (!c || (c.kindergartenId as unknown as string) !== kg)
      return Promise.resolve(null);
    return Promise.resolve(c);
  }
  findByKindergartenAndIin(_kg: string, _iin: string): Promise<Child | null> {
    return Promise.resolve(null);
  }
  update(_c: Child): Promise<void> {
    throw new Error('not used');
  }
  list(
    _kg: string,
    _filters: ChildListFilters,
    _page: PageRequest,
  ): Promise<PageResult<Child>> {
    throw new Error('not used');
  }
  countActiveByGroup(_kg: string, _gid: string): Promise<number> {
    return Promise.resolve(0);
  }
  recordGroupTransfer(): Promise<void> {
    throw new Error('not used');
  }
  listGroupHistory(
    _kg: string,
    _cId: string,
  ): Promise<ChildGroupHistoryRecord[]> {
    return Promise.resolve([]);
  }
  findByIinCrossTenant(_iin: string): Promise<Child[]> {
    return Promise.resolve([]);
  }
  findByIdsCrossTenant(_ids: string[]): Promise<Child[]> {
    return Promise.resolve([]);
  }
}

class FakeLocationRepo extends LocationRepository {
  byId = new Map<string, Location>();

  put(l: Location): void {
    this.byId.set(l.id, l);
  }
  create(_kg: string, _input: CreateLocationInput): Promise<Location> {
    throw new Error('not used');
  }
  findById(kg: string, id: string): Promise<Location | null> {
    const l = this.byId.get(id);
    if (!l || l.kindergartenId !== kg) return Promise.resolve(null);
    return Promise.resolve(l);
  }
  list(_kg: string, _filters?: ListLocationsFilters): Promise<Location[]> {
    throw new Error('not used');
  }
  update(
    _kg: string,
    _id: string,
    _patch: UpdateLocationInput,
  ): Promise<Location | null> {
    throw new Error('not used');
  }
  save(l: Location): Promise<Location> {
    this.byId.set(l.id, l);
    return Promise.resolve(l);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

function makeLocation(kg: string, id: string, name: string): Location {
  return Location.hydrate({
    id,
    kindergartenId: kg,
    name,
    description: null,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function makeEvent(
  kg: string,
  id: string,
  groupId: string,
  locationId: string | null,
): ActivityEvent {
  return ActivityEvent.hydrate({
    id,
    kindergartenId: kg,
    groupId,
    templateSlotId: null,
    origin: 'adhoc',
    activityName: 'Test Activity',
    category: 'activity',
    locationId,
    startsAt: NOW,
    endsAt: null,
    status: 'scheduled',
    createdBy: null,
    notes: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function makeGroup(kg: string, id: string): Group {
  return Group.hydrate({
    id,
    kindergartenId: kg,
    name: `Group-${id}`,
    capacity: 20,
    ageRangeMin: 3,
    ageRangeMax: 5,
    currentLocationId: null,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function makeChild(
  kg: string,
  id: string,
  currentGroupId: string | null,
): Child {
  return Child.hydrate({
    id,
    kindergartenId: kg,
    iin: null,
    fullName: 'Test Child',
    dateOfBirth: new Date('2022-01-01'),
    gender: null,
    photoUrl: null,
    status: 'active',
    currentGroupId,
    enrollmentDate: NOW,
    archivedAt: null,
    archiveReason: null,
    medicalNotes: null,
    allergyNotes: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

interface Wired {
  service: ScheduleService;
  templateRepo: FakeScheduleTemplateRepo;
  eventRepo: FakeActivityEventRepo;
  snapshotRepo: FakeWeekSnapshotRepo;
  groupRepo: FakeGroupRepo;
  childRepo: FakeChildRepo;
  locationRepo: FakeLocationRepo;
}

/**
 * @param withLocationRepo when false, the optional LocationRepository is left
 *   undefined so the fail-closed branch of `resolveLocationName(s)` can be
 *   asserted. The returned `locationRepo` fake is still constructed for the
 *   caller's convenience but is NOT injected.
 */
function wire(withLocationRepo = true): Wired {
  const templateRepo = new FakeScheduleTemplateRepo();
  const eventRepo = new FakeActivityEventRepo();
  const snapshotRepo = new FakeWeekSnapshotRepo();
  const groupRepo = new FakeGroupRepo();
  const childRepo = new FakeChildRepo();
  const locationRepo = new FakeLocationRepo();
  const clock = new FixedClock(NOW);
  const service = new ScheduleService(
    templateRepo,
    eventRepo,
    snapshotRepo,
    groupRepo,
    childRepo,
    clock,
    withLocationRepo ? locationRepo : undefined,
  );
  return {
    service,
    templateRepo,
    eventRepo,
    snapshotRepo,
    groupRepo,
    childRepo,
    locationRepo,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('ScheduleService — service-unit', () => {
  describe('createTemplate', () => {
    it('returns a fresh template when group exists', async () => {
      const { service, groupRepo } = wire();
      groupRepo.put(makeGroup(KG, GROUP_A));
      const created = await service.createTemplate(KG, {
        groupId: GROUP_A,
        name: 'Standard',
        validFrom: new Date('2026-05-04'),
      });
      expect(created.kindergartenId).toBe(KG);
      expect(created.name).toBe('Standard');
      expect(created.isActive).toBe(true);
    });

    it('throws GroupNotFoundError when group is unknown', async () => {
      const { service } = wire();
      await expect(
        service.createTemplate(KG, {
          groupId: GROUP_A,
          name: 'X',
          validFrom: new Date('2026-05-04'),
        }),
      ).rejects.toBeInstanceOf(GroupNotFoundError);
    });

    it('allows kindergarten-wide template (groupId omitted)', async () => {
      const { service } = wire();
      const t = await service.createTemplate(KG, {
        name: 'KG-wide',
        validFrom: new Date('2026-05-04'),
      });
      expect(t.groupId).toBeNull();
    });
  });

  describe('addSlot', () => {
    it('persists a slot and returns the reloaded template', async () => {
      const { service, groupRepo } = wire();
      groupRepo.put(makeGroup(KG, GROUP_A));
      const t = await service.createTemplate(KG, {
        groupId: GROUP_A,
        name: 'Std',
        validFrom: new Date('2026-05-04'),
      });
      const updated = await service.addSlot(KG, t.id, {
        dayOfWeek: 'mon',
        startTime: '09:00',
        endTime: '09:45',
        activityName: 'Morning Circle',
      });
      expect(updated.slots).toHaveLength(1);
      // category omitted → server default 'activity'.
      expect(updated.slots[0].category).toBe('activity');
    });

    it('persists an explicit slot category', async () => {
      const { service, groupRepo } = wire();
      groupRepo.put(makeGroup(KG, GROUP_A));
      const t = await service.createTemplate(KG, {
        groupId: GROUP_A,
        name: 'Std',
        validFrom: new Date('2026-05-04'),
      });
      const updated = await service.addSlot(KG, t.id, {
        dayOfWeek: 'mon',
        startTime: '13:00',
        endTime: '15:00',
        activityName: 'Тихий час',
        category: 'sleep',
      });
      expect(updated.slots[0].category).toBe('sleep');
    });

    it('throws SlotConflictError when (day, startTime) already exists', async () => {
      const { service, groupRepo } = wire();
      groupRepo.put(makeGroup(KG, GROUP_A));
      const t = await service.createTemplate(KG, {
        groupId: GROUP_A,
        name: 'Std',
        validFrom: new Date('2026-05-04'),
      });
      await service.addSlot(KG, t.id, {
        dayOfWeek: 'mon',
        startTime: '09:00',
        endTime: '09:45',
        activityName: 'A',
      });
      await expect(
        service.addSlot(KG, t.id, {
          dayOfWeek: 'mon',
          startTime: '09:00',
          endTime: '10:00',
          activityName: 'B',
        }),
      ).rejects.toBeInstanceOf(SlotConflictError);
    });

    it('throws ScheduleTemplateNotFoundError when template is unknown', async () => {
      const { service } = wire();
      await expect(
        service.addSlot(KG, 'no-such-id', {
          dayOfWeek: 'mon',
          startTime: '09:00',
          endTime: '09:45',
          activityName: 'A',
        }),
      ).rejects.toBeInstanceOf(ScheduleTemplateNotFoundError);
    });
  });

  describe('activity event state machine', () => {
    async function setupEvent(): Promise<{
      service: ScheduleService;
      eventRepo: FakeActivityEventRepo;
      eventId: string;
    }> {
      const w = wire();
      w.groupRepo.put(makeGroup(KG, GROUP_A));
      const created = await w.service.createAdHocEvent(KG, {
        groupId: GROUP_A,
        activityName: 'Walk',
        startsAt: new Date('2026-05-04T09:00:00.000Z'),
        endsAt: new Date('2026-05-04T10:00:00.000Z'),
      });
      return {
        service: w.service,
        eventRepo: w.eventRepo,
        eventId: created.id,
      };
    }

    it('starts a scheduled event', async () => {
      const { service, eventId } = await setupEvent();
      const updated = await service.startEvent(KG, eventId);
      expect(updated.status.value).toBe('in_progress');
    });

    it('completes an in_progress event', async () => {
      const { service, eventId } = await setupEvent();
      await service.startEvent(KG, eventId);
      const updated = await service.completeEvent(KG, eventId);
      expect(updated.status.value).toBe('completed');
    });

    it('cancels a scheduled event with reason', async () => {
      const { service, eventId } = await setupEvent();
      const updated = await service.cancelEvent(KG, eventId, 'weather');
      expect(updated.status.value).toBe('cancelled');
      expect(updated.notes).toMatch(/cancelled: weather/);
    });

    it('throws InvalidEventTransitionError on duplicate complete()', async () => {
      const { service, eventId } = await setupEvent();
      await service.startEvent(KG, eventId);
      await service.completeEvent(KG, eventId);
      await expect(service.completeEvent(KG, eventId)).rejects.toBeInstanceOf(
        InvalidEventTransitionError,
      );
    });

    it('throws ActivityEventNotFoundError when event id is unknown', async () => {
      const { service } = wire();
      await expect(service.startEvent(KG, 'no-such')).rejects.toBeInstanceOf(
        ActivityEventNotFoundError,
      );
    });

    it('throws EventTransitionConflictError when start() conditional UPDATE matches 0 rows (lost-update race)', async () => {
      const { service, eventRepo, eventId } = await setupEvent();
      // Simulate a concurrent transition: the service reads status=scheduled
      // and validates locally, but by the time the conditional UPDATE runs
      // another request has already moved the row to `cancelled`. The fake
      // repo's `updateWithExpectedStatus` then returns false → 409.
      const origUpdate = eventRepo.updateWithExpectedStatus.bind(eventRepo);
      eventRepo.updateWithExpectedStatus = () => Promise.resolve(false);
      try {
        await expect(service.startEvent(KG, eventId)).rejects.toBeInstanceOf(
          EventTransitionConflictError,
        );
      } finally {
        eventRepo.updateWithExpectedStatus = origUpdate;
      }
    });

    it('throws EventTransitionConflictError when cancel() loses the race', async () => {
      const { service, eventRepo, eventId } = await setupEvent();
      const origUpdate = eventRepo.updateWithExpectedStatus.bind(eventRepo);
      eventRepo.updateWithExpectedStatus = () => Promise.resolve(false);
      try {
        await expect(
          service.cancelEvent(KG, eventId, 'weather'),
        ).rejects.toBeInstanceOf(EventTransitionConflictError);
      } finally {
        eventRepo.updateWithExpectedStatus = origUpdate;
      }
    });

    it('throws EventTransitionConflictError when complete() loses the race', async () => {
      const { service, eventRepo, eventId } = await setupEvent();
      await service.startEvent(KG, eventId);
      const origUpdate = eventRepo.updateWithExpectedStatus.bind(eventRepo);
      eventRepo.updateWithExpectedStatus = () => Promise.resolve(false);
      try {
        await expect(service.completeEvent(KG, eventId)).rejects.toBeInstanceOf(
          EventTransitionConflictError,
        );
      } finally {
        eventRepo.updateWithExpectedStatus = origUpdate;
      }
    });
  });

  describe('deleteEvent', () => {
    it('deletes when status is scheduled', async () => {
      const w = wire();
      w.groupRepo.put(makeGroup(KG, GROUP_A));
      const e = await w.service.createAdHocEvent(KG, {
        groupId: GROUP_A,
        activityName: 'Walk',
        startsAt: new Date('2026-05-04T09:00:00.000Z'),
      });
      await w.service.deleteEvent(KG, e.id);
      const found = await w.eventRepo.findById(KG, e.id);
      expect(found).toBeNull();
    });

    it('throws EventNotDeletableError once started', async () => {
      const w = wire();
      w.groupRepo.put(makeGroup(KG, GROUP_A));
      const e = await w.service.createAdHocEvent(KG, {
        groupId: GROUP_A,
        activityName: 'Walk',
        startsAt: new Date('2026-05-04T09:00:00.000Z'),
      });
      await w.service.startEvent(KG, e.id);
      await expect(w.service.deleteEvent(KG, e.id)).rejects.toBeInstanceOf(
        EventNotDeletableError,
      );
    });
  });

  describe('listEvents filters', () => {
    it('filters by groupId, date range, and status', async () => {
      const w = wire();
      w.groupRepo.put(makeGroup(KG, GROUP_A));
      w.groupRepo.put(makeGroup(KG, GROUP_B));
      // Group A — Mon, Tue
      await w.service.createAdHocEvent(KG, {
        groupId: GROUP_A,
        activityName: 'A-Mon',
        startsAt: new Date('2026-05-04T09:00:00.000Z'),
      });
      await w.service.createAdHocEvent(KG, {
        groupId: GROUP_A,
        activityName: 'A-Tue',
        startsAt: new Date('2026-05-05T09:00:00.000Z'),
      });
      // Group B — Mon
      await w.service.createAdHocEvent(KG, {
        groupId: GROUP_B,
        activityName: 'B-Mon',
        startsAt: new Date('2026-05-04T09:00:00.000Z'),
      });

      const items = await w.service.listEvents(KG, {
        groupId: GROUP_A,
        from: new Date('2026-05-04'),
        to: new Date('2026-05-05'),
      });
      expect(items).toHaveLength(1);
      expect(items[0].activityName).toBe('A-Mon');
    });
  });

  describe('copyWeekToNext (idempotent)', () => {
    function setupGroupAndTemplate(w: Wired): void {
      w.groupRepo.put(makeGroup(KG, GROUP_A));
      const tpl = ScheduleTemplate.hydrate({
        id: 'tpl-1',
        kindergartenId: KG,
        groupId: GROUP_A,
        name: 'Std',
        recurrence: 'weekly',
        isActive: true,
        validFrom: new Date('2026-04-01'),
        validUntil: null,
        createdAt: NOW,
        slots: [
          {
            id: 'slot-mon',
            templateId: 'tpl-1',
            dayOfWeek: 'mon',
            startTime: '09:00:00',
            endTime: '09:45:00',
            activityName: 'Morning Circle',
            category: 'lesson',
            locationId: null,
            description: null,
          },
          {
            id: 'slot-tue',
            templateId: 'tpl-1',
            dayOfWeek: 'tue',
            startTime: '10:00:00',
            endTime: '11:00:00',
            activityName: 'IZO',
            category: 'meal',
            locationId: null,
            description: null,
          },
        ],
      });
      w.templateRepo.put(tpl);
    }

    it('creates events + snapshot on first call, idempotent skip on second', async () => {
      const w = wire();
      setupGroupAndTemplate(w);

      // 2026-04-27 is a Monday in UTC.
      const fromMonday = new Date('2026-04-27T00:00:00.000Z');

      const first = await w.service.copyWeekToNext(KG, fromMonday, 'manual');
      expect(first.copiedGroups).toBe(1);
      expect(first.skippedGroups).toBe(0);
      expect(first.totalEvents).toBe(2);

      // Snapshot must exist for nextMonday = 2026-05-04.
      const nextMonday = new Date('2026-05-04T00:00:00.000Z');
      const snap = await w.snapshotRepo.findByGroupAndWeek(
        KG,
        GROUP_A,
        nextMonday,
      );
      expect(snap).not.toBeNull();

      // Second call → no-op for this group.
      const second = await w.service.copyWeekToNext(KG, fromMonday, 'manual');
      expect(second.copiedGroups).toBe(0);
      expect(second.skippedGroups).toBe(1);
      expect(second.totalEvents).toBe(0);
    });

    it('places slot events on the right ISO weekday with correct start time', async () => {
      const w = wire();
      setupGroupAndTemplate(w);
      const fromMonday = new Date('2026-04-27T00:00:00.000Z');
      await w.service.copyWeekToNext(KG, fromMonday, 'manual');

      const allEvents = await w.eventRepo.list(KG, {});
      expect(allEvents).toHaveLength(2);

      const monEvent = allEvents.find(
        (e) => e.activityName === 'Morning Circle',
      )!;
      const tueEvent = allEvents.find((e) => e.activityName === 'IZO')!;
      // Slot times are a naive wall clock authored in the kindergarten's zone
      // (Asia/Almaty, UTC+5): 09:00 local on Mon 2026-05-04 is 04:00Z, and
      // 10:00 local on Tue 2026-05-05 is 05:00Z. The old projection declared the
      // wall clock to BE UTC and shifted every event +5h.
      expect(monEvent.startsAt.toISOString()).toBe('2026-05-04T04:00:00.000Z');
      expect(tueEvent.startsAt.toISOString()).toBe('2026-05-05T05:00:00.000Z');
    });

    it('projects slot end times in the kindergarten timezone too', async () => {
      const w = wire();
      setupGroupAndTemplate(w);
      await w.service.copyWeekToNext(
        KG,
        new Date('2026-04-27T00:00:00.000Z'),
        'manual',
      );
      const monEvent = (await w.eventRepo.list(KG, {})).find(
        (e) => e.activityName === 'Morning Circle',
      )!;
      // 09:45 Almaty → 04:45Z.
      expect(monEvent.endsAt!.toISOString()).toBe('2026-05-04T04:45:00.000Z');
    });

    it('copies each slot category onto the projected activity_event', async () => {
      const w = wire();
      setupGroupAndTemplate(w);
      const fromMonday = new Date('2026-04-27T00:00:00.000Z');
      await w.service.copyWeekToNext(KG, fromMonday, 'manual');

      const allEvents = await w.eventRepo.list(KG, {});
      const monEvent = allEvents.find(
        (e) => e.activityName === 'Morning Circle',
      )!;
      const tueEvent = allEvents.find((e) => e.activityName === 'IZO')!;
      expect(monEvent.category).toBe('lesson');
      expect(tueEvent.category).toBe('meal');
    });

    it('marks new snapshots with the source argument (manual vs cron)', async () => {
      const w = wire();
      setupGroupAndTemplate(w);
      const fromMonday = new Date('2026-04-27T00:00:00.000Z');
      const result = await w.service.copyWeekToNext(KG, fromMonday, 'cron');
      expect(result.snapshots).toHaveLength(1);
      expect(result.snapshots[0].source).toBe('cron');
    });
  });

  describe('rematerializeFutureWeeks', () => {
    // NOW is Thu 2026-04-30T10:00:00Z, so the current ISO week starts Mon
    // 2026-04-27 and `startsAt > now` bites in the middle of that week.
    const WEEK_PAST = new Date('2026-04-20T00:00:00.000Z');
    const WEEK_CURRENT = new Date('2026-04-27T00:00:00.000Z');
    const WEEK_NEXT = new Date('2026-05-04T00:00:00.000Z');

    interface SlotSeed {
      id: string;
      dayOfWeek: string;
      startTime: string;
      endTime: string;
      activityName: string;
    }

    function putTemplate(
      w: Wired,
      id: string,
      groupId: string | null,
      slots: SlotSeed[],
    ): void {
      w.templateRepo.put(
        ScheduleTemplate.hydrate({
          id,
          kindergartenId: KG,
          groupId,
          name: `Template-${id}`,
          recurrence: 'weekly',
          isActive: true,
          validFrom: new Date('2026-04-01'),
          validUntil: null,
          createdAt: NOW,
          slots: slots.map((s) => ({
            id: s.id,
            templateId: id,
            dayOfWeek: s.dayOfWeek as never,
            startTime: s.startTime,
            endTime: s.endTime,
            activityName: s.activityName,
            category: 'activity' as const,
            locationId: null,
            description: null,
          })),
        }),
      );
    }

    function putSnapshot(w: Wired, groupId: string, weekStart: Date): void {
      w.snapshotRepo.rows.push(
        ScheduleWeekSnapshot.createNew(
          {
            id: `snap-${groupId}-${weekStart.toISOString().slice(0, 10)}`,
            kindergartenId: KG,
            groupId,
            weekStartDate: weekStart,
            source: 'cron',
            copiedFrom: null,
          },
          NOW,
        ),
      );
    }

    function putEvent(
      w: Wired,
      seed: {
        id: string;
        groupId?: string;
        startsAt: string;
        activityName?: string;
        origin?: 'template' | 'adhoc';
        status?: ActivityEventStatusValue;
        templateSlotId?: string | null;
      },
    ): void {
      w.eventRepo.put(
        ActivityEvent.hydrate({
          id: seed.id,
          kindergartenId: KG,
          groupId: seed.groupId ?? GROUP_A,
          templateSlotId: seed.templateSlotId ?? null,
          origin: seed.origin ?? 'template',
          activityName: seed.activityName ?? 'Seeded',
          category: 'activity',
          locationId: null,
          startsAt: new Date(seed.startsAt),
          endsAt: null,
          status: seed.status ?? 'scheduled',
          createdBy: null,
          notes: null,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      );
    }

    /**
     * Simulate what the FK does on a template edit: `save()` DELETEs the dropped
     * slot rows and `activity_events.template_slot_id` (ON DELETE SET NULL) goes
     * NULL on every already-materialized event. `origin` survives — that is the
     * whole reason it exists.
     */
    function nullOutTemplateSlotFks(w: Wired): void {
      for (const [id, e] of [...w.eventRepo.rows]) {
        const state = e.toState();
        if (state.origin === 'template') {
          w.eventRepo.rows.set(
            id,
            ActivityEvent.hydrate({ ...state, templateSlotId: null }),
          );
        }
      }
    }

    async function names(w: Wired, groupId?: string): Promise<string[]> {
      const events = await w.eventRepo.list(KG, { groupId });
      return events.map((e) => e.activityName).sort();
    }

    it('returns exactly the new slots and zero ghosts after a template slot set is replaced', async () => {
      // The production scenario end-to-end: a week is materialized once, the
      // admin then rewrites the template, and parents are left staring at the
      // old slots forever because copyWeekToNext will never revisit the week.
      const w = wire();
      w.groupRepo.put(makeGroup(KG, GROUP_A));
      putTemplate(w, 'tpl-1', GROUP_A, [
        {
          id: 'slot-old-1',
          dayOfWeek: 'mon',
          startTime: '09:00:00',
          endTime: '09:45:00',
          activityName: 'Ghost A',
        },
        {
          id: 'slot-old-2',
          dayOfWeek: 'tue',
          startTime: '10:00:00',
          endTime: '11:00:00',
          activityName: 'Ghost B',
        },
      ]);

      // 1) Cron materializes next week from the 2-slot template.
      await w.service.copyWeekToNext(KG, WEEK_CURRENT, 'manual');
      expect(await names(w)).toEqual(['Ghost A', 'Ghost B']);

      // 2) Admin replaces the slot set entirely — old slot ids are gone and the
      //    FK NULLs template_slot_id on the two live events.
      putTemplate(w, 'tpl-1', GROUP_A, [
        {
          id: 'slot-new-1',
          dayOfWeek: 'mon',
          startTime: '08:00:00',
          endTime: '08:45:00',
          activityName: 'Real A',
        },
        {
          id: 'slot-new-2',
          dayOfWeek: 'wed',
          startTime: '11:00:00',
          endTime: '12:00:00',
          activityName: 'Real B',
        },
        {
          id: 'slot-new-3',
          dayOfWeek: 'fri',
          startTime: '15:00:00',
          endTime: '16:00:00',
          activityName: 'Real C',
        },
      ]);
      nullOutTemplateSlotFks(w);

      // 3) The bridge.
      const result = await w.service.rematerializeFutureWeeks(KG, {
        groupId: GROUP_A,
      });

      expect(result.rebuiltWeeks).toBe(1);
      expect(result.deletedEvents).toBe(2);
      expect(result.insertedEvents).toBe(3);
      expect(await names(w)).toEqual(['Real A', 'Real B', 'Real C']);
    });

    it('deletes template orphans whose template_slot_id is already NULL', async () => {
      // The ghost-slot case in isolation: `origin` is the only handle left.
      const w = wire();
      w.groupRepo.put(makeGroup(KG, GROUP_A));
      putSnapshot(w, GROUP_A, WEEK_NEXT);
      putEvent(w, {
        id: 'orphan-1',
        startsAt: '2026-05-04T04:00:00.000Z',
        activityName: 'Orphan',
        origin: 'template',
        templateSlotId: null,
      });

      const result = await w.service.rematerializeFutureWeeks(KG, {
        groupId: GROUP_A,
      });

      expect(result.deletedEvents).toBe(1);
      expect(await names(w)).toEqual([]);
    });

    it('returns zero work and preserves events for weeks that have no snapshot', async () => {
      // The cron owns the forward horizon — we must not materialize a new week.
      const w = wire();
      w.groupRepo.put(makeGroup(KG, GROUP_A));
      putTemplate(w, 'tpl-1', GROUP_A, [
        {
          id: 'slot-1',
          dayOfWeek: 'mon',
          startTime: '09:00:00',
          endTime: '09:45:00',
          activityName: 'A',
        },
      ]);

      const result = await w.service.rematerializeFutureWeeks(KG, {
        groupId: GROUP_A,
      });

      expect(result).toEqual({
        rebuiltWeeks: 0,
        deletedEvents: 0,
        insertedEvents: 0,
      });
      expect(await w.eventRepo.list(KG, {})).toHaveLength(0);
    });

    it('preserves events in past weeks (no snapshot in range)', async () => {
      const w = wire();
      w.groupRepo.put(makeGroup(KG, GROUP_A));
      putSnapshot(w, GROUP_A, WEEK_PAST);
      putEvent(w, {
        id: 'past-1',
        startsAt: '2026-04-20T04:00:00.000Z',
        activityName: 'Last week',
      });

      const result = await w.service.rematerializeFutureWeeks(KG, {
        groupId: GROUP_A,
      });

      expect(result.rebuiltWeeks).toBe(0);
      expect(result.deletedEvents).toBe(0);
      expect(await names(w)).toEqual(['Last week']);
    });

    it('preserves events that are not in scheduled status', async () => {
      const w = wire();
      w.groupRepo.put(makeGroup(KG, GROUP_A));
      putSnapshot(w, GROUP_A, WEEK_NEXT);
      putEvent(w, {
        id: 'ip-1',
        startsAt: '2026-05-04T04:00:00.000Z',
        activityName: 'In progress',
        status: 'in_progress',
      });
      putEvent(w, {
        id: 'done-1',
        startsAt: '2026-05-04T05:00:00.000Z',
        activityName: 'Completed',
        status: 'completed',
      });
      putEvent(w, {
        id: 'cancelled-1',
        startsAt: '2026-05-04T06:00:00.000Z',
        activityName: 'Cancelled',
        status: 'cancelled',
      });

      const result = await w.service.rematerializeFutureWeeks(KG, {
        groupId: GROUP_A,
      });

      expect(result.deletedEvents).toBe(0);
      expect(await names(w)).toEqual(['Cancelled', 'Completed', 'In progress']);
    });

    it('preserves ad-hoc events and never recreates them', async () => {
      const w = wire();
      w.groupRepo.put(makeGroup(KG, GROUP_A));
      putSnapshot(w, GROUP_A, WEEK_NEXT);
      putEvent(w, {
        id: 'adhoc-1',
        startsAt: '2026-05-06T04:00:00.000Z',
        activityName: 'Museum trip',
        origin: 'adhoc',
      });
      putTemplate(w, 'tpl-1', GROUP_A, [
        {
          id: 'slot-1',
          dayOfWeek: 'mon',
          startTime: '09:00:00',
          endTime: '09:45:00',
          activityName: 'Morning Circle',
        },
      ]);

      const result = await w.service.rematerializeFutureWeeks(KG, {
        groupId: GROUP_A,
      });

      expect(result.deletedEvents).toBe(0);
      expect(result.insertedEvents).toBe(1);
      expect(await names(w)).toEqual(['Morning Circle', 'Museum trip']);
    });

    it('rebuilds the remainder of the current week while preserving what already started', async () => {
      // This is the whole point of the `starts_at > now` guard: an edit made on
      // Thursday morning fixes Thursday afternoon onward, today — not in two
      // weeks — and does not rewrite Thursday morning.
      const w = wire();
      w.groupRepo.put(makeGroup(KG, GROUP_A));
      putSnapshot(w, GROUP_A, WEEK_CURRENT);
      // Thu 09:00 Almaty = 04:00Z, i.e. BEFORE now (10:00Z).
      putEvent(w, {
        id: 'earlier-today',
        startsAt: '2026-04-30T04:00:00.000Z',
        activityName: 'Morning Circle',
      });
      // Thu 16:00 Almaty = 11:00Z, i.e. AFTER now → stale, must be rebuilt.
      putEvent(w, {
        id: 'later-today',
        startsAt: '2026-04-30T11:00:00.000Z',
        activityName: 'Stale Afternoon',
      });
      putTemplate(w, 'tpl-1', GROUP_A, [
        {
          id: 'slot-morning',
          dayOfWeek: 'thu',
          startTime: '09:00:00',
          endTime: '09:45:00',
          activityName: 'Morning Circle',
        },
        {
          id: 'slot-afternoon',
          dayOfWeek: 'thu',
          startTime: '16:00:00',
          endTime: '17:00:00',
          activityName: 'Fresh Afternoon',
        },
      ]);

      const result = await w.service.rematerializeFutureWeeks(KG, {
        groupId: GROUP_A,
      });

      expect(result.deletedEvents).toBe(1);
      expect(result.insertedEvents).toBe(1);
      // The morning slot is neither deleted nor re-inserted → exactly one copy.
      expect(await names(w)).toEqual(['Fresh Afternoon', 'Morning Circle']);
    });

    it('narrows to a single group when groupId is given', async () => {
      const w = wire();
      w.groupRepo.put(makeGroup(KG, GROUP_A));
      w.groupRepo.put(makeGroup(KG, GROUP_B));
      putSnapshot(w, GROUP_A, WEEK_NEXT);
      putSnapshot(w, GROUP_B, WEEK_NEXT);
      putEvent(w, {
        id: 'a-1',
        groupId: GROUP_A,
        startsAt: '2026-05-04T04:00:00.000Z',
        activityName: 'A stale',
      });
      putEvent(w, {
        id: 'b-1',
        groupId: GROUP_B,
        startsAt: '2026-05-04T04:00:00.000Z',
        activityName: 'B untouched',
      });

      const result = await w.service.rematerializeFutureWeeks(KG, {
        groupId: GROUP_A,
      });

      expect(result.rebuiltWeeks).toBe(1);
      expect(result.deletedEvents).toBe(1);
      expect(await names(w)).toEqual(['B untouched']);
    });

    it('rebuilds every group when groupId is null (kindergarten-wide template)', async () => {
      const w = wire();
      w.groupRepo.put(makeGroup(KG, GROUP_A));
      w.groupRepo.put(makeGroup(KG, GROUP_B));
      putSnapshot(w, GROUP_A, WEEK_NEXT);
      putSnapshot(w, GROUP_B, WEEK_NEXT);
      // groupId: null → applies to both groups.
      putTemplate(w, 'tpl-kgwide', null, [
        {
          id: 'slot-1',
          dayOfWeek: 'mon',
          startTime: '09:00:00',
          endTime: '09:45:00',
          activityName: 'Zaryadka',
        },
      ]);

      const result = await w.service.rematerializeFutureWeeks(KG, {
        groupId: null,
      });

      expect(result.rebuiltWeeks).toBe(2);
      expect(result.insertedEvents).toBe(2);
      expect(await names(w, GROUP_A)).toEqual(['Zaryadka']);
      expect(await names(w, GROUP_B)).toEqual(['Zaryadka']);
    });

    it('treats an omitted groupId the same as null', async () => {
      const w = wire();
      w.groupRepo.put(makeGroup(KG, GROUP_A));
      w.groupRepo.put(makeGroup(KG, GROUP_B));
      putSnapshot(w, GROUP_A, WEEK_NEXT);
      putSnapshot(w, GROUP_B, WEEK_NEXT);

      const result = await w.service.rematerializeFutureWeeks(KG, {});

      expect(result.rebuiltWeeks).toBe(2);
    });

    it('rebuilds both the current and the next week when both are materialized', async () => {
      const w = wire();
      w.groupRepo.put(makeGroup(KG, GROUP_A));
      putSnapshot(w, GROUP_A, WEEK_CURRENT);
      putSnapshot(w, GROUP_A, WEEK_NEXT);
      // Fri 15:00 Almaty = 10:00Z — future in both weeks.
      putTemplate(w, 'tpl-1', GROUP_A, [
        {
          id: 'slot-fri',
          dayOfWeek: 'fri',
          startTime: '15:00:00',
          endTime: '16:00:00',
          activityName: 'Friday Music',
        },
      ]);

      const result = await w.service.rematerializeFutureWeeks(KG, {
        groupId: GROUP_A,
      });

      expect(result.rebuiltWeeks).toBe(2);
      expect(result.insertedEvents).toBe(2);
      const starts = (await w.eventRepo.list(KG, {})).map((e) =>
        e.startsAt.toISOString(),
      );
      expect(starts).toEqual([
        '2026-05-01T10:00:00.000Z', // Fri of the current week
        '2026-05-08T10:00:00.000Z', // Fri of next week
      ]);
    });

    it('ignores an inactive template (its future events are swept)', async () => {
      const w = wire();
      w.groupRepo.put(makeGroup(KG, GROUP_A));
      putSnapshot(w, GROUP_A, WEEK_NEXT);
      putEvent(w, {
        id: 'stale-1',
        startsAt: '2026-05-04T04:00:00.000Z',
        activityName: 'From a since-deactivated template',
      });
      w.templateRepo.put(
        ScheduleTemplate.hydrate({
          id: 'tpl-off',
          kindergartenId: KG,
          groupId: GROUP_A,
          name: 'Off',
          recurrence: 'weekly',
          isActive: false,
          validFrom: new Date('2026-04-01'),
          validUntil: null,
          createdAt: NOW,
          slots: [
            {
              id: 'slot-1',
              templateId: 'tpl-off',
              dayOfWeek: 'mon',
              startTime: '09:00:00',
              endTime: '09:45:00',
              activityName: 'Should not appear',
              category: 'activity',
              locationId: null,
              description: null,
            },
          ],
        }),
      );

      const result = await w.service.rematerializeFutureWeeks(KG, {
        groupId: GROUP_A,
      });

      expect(result.deletedEvents).toBe(1);
      expect(result.insertedEvents).toBe(0);
      expect(await names(w)).toEqual([]);
    });

    it('does not touch another tenant', async () => {
      const w = wire();
      w.groupRepo.put(makeGroup(KG, GROUP_A));
      putSnapshot(w, GROUP_A, WEEK_NEXT);
      w.eventRepo.put(
        ActivityEvent.hydrate({
          id: 'other-kg-1',
          kindergartenId: KG_OTHER,
          groupId: GROUP_A,
          templateSlotId: null,
          origin: 'template',
          activityName: 'Other tenant',
          category: 'activity',
          locationId: null,
          startsAt: new Date('2026-05-04T04:00:00.000Z'),
          endsAt: null,
          status: 'scheduled',
          createdBy: null,
          notes: null,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      );

      await w.service.rematerializeFutureWeeks(KG, { groupId: GROUP_A });

      expect(await w.eventRepo.findById(KG_OTHER, 'other-kg-1')).not.toBeNull();
    });

    it('resolves the right week when PG hands back week_start_date as a local-midnight Date', async () => {
      // node-postgres parses a bare `date` with `new Date(y, m-1, d)`, i.e.
      // LOCAL midnight. East of Greenwich that instant belongs to the PREVIOUS
      // UTC day (on UTC+5, '2026-05-04' → 2026-05-03T19:00Z, a Sunday), and a
      // naive startOfIsoWeek would snap it back to the previous Monday and
      // rebuild the wrong week. Emulate that parse explicitly.
      const w = wire();
      w.groupRepo.put(makeGroup(KG, GROUP_A));
      w.snapshotRepo.rows.push(
        ScheduleWeekSnapshot.createNew(
          {
            id: 'snap-local-midnight',
            kindergartenId: KG,
            groupId: GROUP_A,
            weekStartDate: new Date('2026-05-03T19:00:00.000Z'),
            source: 'cron',
            copiedFrom: null,
          },
          NOW,
        ),
      );
      putTemplate(w, 'tpl-1', GROUP_A, [
        {
          id: 'slot-mon',
          dayOfWeek: 'mon',
          startTime: '09:00:00',
          endTime: '09:45:00',
          activityName: 'Morning Circle',
        },
      ]);

      const result = await w.service.rematerializeFutureWeeks(KG, {
        groupId: GROUP_A,
      });

      expect(result.rebuiltWeeks).toBe(1);
      expect(result.insertedEvents).toBe(1);
      const [event] = await w.eventRepo.list(KG, {});
      // Monday of the intended week (2026-05-04), NOT 2026-04-27.
      expect(event.startsAt.toISOString()).toBe('2026-05-04T04:00:00.000Z');
    });
  });

  describe('template mutations re-sync materialized weeks', () => {
    const WEEK_NEXT = new Date('2026-05-04T00:00:00.000Z');

    /**
     * Group + snapshot for next week + a real template carrying one Monday slot,
     * created through the service so the ids are the ones the service knows.
     */
    async function setup(): Promise<{ w: Wired; templateId: string }> {
      const w = wire();
      w.groupRepo.put(makeGroup(KG, GROUP_A));
      w.snapshotRepo.rows.push(
        ScheduleWeekSnapshot.createNew(
          {
            id: 'snap-1',
            kindergartenId: KG,
            groupId: GROUP_A,
            weekStartDate: WEEK_NEXT,
            source: 'cron',
            copiedFrom: null,
          },
          NOW,
        ),
      );
      const tpl = await w.service.createTemplate(KG, {
        groupId: GROUP_A,
        name: 'Std',
        validFrom: new Date('2026-04-01'),
      });
      return { w, templateId: tpl.id };
    }

    it('materializes the new slot into the already-snapshotted week on addSlot', async () => {
      const { w, templateId } = await setup();
      await w.service.addSlot(KG, templateId, {
        dayOfWeek: 'mon',
        startTime: '09:00',
        endTime: '09:45',
        activityName: 'Morning Circle',
      });
      const events = await w.eventRepo.list(KG, {});
      expect(events).toHaveLength(1);
      expect(events[0].activityName).toBe('Morning Circle');
      expect(events[0].origin).toBe('template');
      expect(events[0].startsAt.toISOString()).toBe('2026-05-04T04:00:00.000Z');
    });

    it('rewrites the materialized event on updateSlot', async () => {
      const { w, templateId } = await setup();
      const tpl = await w.service.addSlot(KG, templateId, {
        dayOfWeek: 'mon',
        startTime: '09:00',
        endTime: '09:45',
        activityName: 'Old Name',
      });
      await w.service.updateSlot(KG, templateId, tpl.slots[0].id, {
        activityName: 'New Name',
        startTime: '10:00',
        endTime: '10:45',
      });
      const events = await w.eventRepo.list(KG, {});
      expect(events).toHaveLength(1);
      expect(events[0].activityName).toBe('New Name');
      expect(events[0].startsAt.toISOString()).toBe('2026-05-04T05:00:00.000Z');
    });

    it('sweeps the materialized event on removeSlot', async () => {
      const { w, templateId } = await setup();
      const tpl = await w.service.addSlot(KG, templateId, {
        dayOfWeek: 'mon',
        startTime: '09:00',
        endTime: '09:45',
        activityName: 'Morning Circle',
      });
      expect(await w.eventRepo.list(KG, {})).toHaveLength(1);

      await w.service.removeSlot(KG, templateId, tpl.slots[0].id);

      expect(await w.eventRepo.list(KG, {})).toHaveLength(0);
    });

    it('sweeps the materialized events on deleteTemplate', async () => {
      const { w, templateId } = await setup();
      await w.service.addSlot(KG, templateId, {
        dayOfWeek: 'mon',
        startTime: '09:00',
        endTime: '09:45',
        activityName: 'Morning Circle',
      });
      expect(await w.eventRepo.list(KG, {})).toHaveLength(1);

      await w.service.deleteTemplate(KG, templateId);

      expect(await w.eventRepo.list(KG, {})).toHaveLength(0);
    });

    it('sweeps the materialized events when updateTemplate deactivates it', async () => {
      const { w, templateId } = await setup();
      await w.service.addSlot(KG, templateId, {
        dayOfWeek: 'mon',
        startTime: '09:00',
        endTime: '09:45',
        activityName: 'Morning Circle',
      });
      expect(await w.eventRepo.list(KG, {})).toHaveLength(1);

      await w.service.updateTemplate(KG, templateId, { isActive: false });

      expect(await w.eventRepo.list(KG, {})).toHaveLength(0);
    });

    it('leaves ad-hoc events untouched across a template mutation', async () => {
      const { w, templateId } = await setup();
      const adhoc = await w.service.createAdHocEvent(KG, {
        groupId: GROUP_A,
        activityName: 'Museum trip',
        startsAt: new Date('2026-05-06T04:00:00.000Z'),
      });
      await w.service.addSlot(KG, templateId, {
        dayOfWeek: 'mon',
        startTime: '09:00',
        endTime: '09:45',
        activityName: 'Morning Circle',
      });
      await w.service.removeSlot(
        KG,
        templateId,
        (await w.service.getTemplate(KG, templateId)).slots[0].id,
      );

      const remaining = await w.eventRepo.list(KG, {});
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(adhoc.id);
    });
  });

  describe('getParentScheduleForChild', () => {
    it("returns the child group's events", async () => {
      const w = wire();
      w.groupRepo.put(makeGroup(KG, GROUP_A));
      w.childRepo.put(makeChild(KG, CHILD_A, GROUP_A));
      await w.service.createAdHocEvent(KG, {
        groupId: GROUP_A,
        activityName: 'Walk',
        startsAt: new Date('2026-05-04T09:00:00.000Z'),
      });
      const items = await w.service.getParentScheduleForChild(KG, CHILD_A, {
        from: new Date('2026-05-04'),
        to: new Date('2026-05-05'),
      });
      expect(items).toHaveLength(1);
      expect(items[0].activityName).toBe('Walk');
    });

    it('throws ChildNotFoundError when child is not in tenant', async () => {
      const w = wire();
      await expect(
        w.service.getParentScheduleForChild(KG, CHILD_A, {
          from: new Date('2026-05-04'),
          to: new Date('2026-05-05'),
        }),
      ).rejects.toBeInstanceOf(ChildNotFoundError);
    });

    it('returns [] when child has no current group', async () => {
      const w = wire();
      w.childRepo.put(makeChild(KG, CHILD_A, null));
      const items = await w.service.getParentScheduleForChild(KG, CHILD_A, {
        from: new Date('2026-05-04'),
        to: new Date('2026-05-05'),
      });
      expect(items).toEqual([]);
    });

    it('throws ChildNotFoundError for cross-tenant child', async () => {
      const w = wire();
      // Child belongs to a different KG.
      w.childRepo.put(makeChild(KG_OTHER, CHILD_A, GROUP_A));
      await expect(
        w.service.getParentScheduleForChild(KG, CHILD_A, {
          from: new Date('2026-05-04'),
          to: new Date('2026-05-05'),
        }),
      ).rejects.toBeInstanceOf(ChildNotFoundError);
    });
  });

  describe('resolveLocationNames (identity overlay)', () => {
    const EV_1 = 'e1111111-1111-1111-1111-111111111111';
    const EV_2 = 'e2222222-2222-2222-2222-222222222222';

    it('resolves the location name for events with a locationId', async () => {
      const w = wire();
      w.locationRepo.put(makeLocation(KG, LOCATION_A, 'Музыкальный зал'));
      const events = [makeEvent(KG, EV_1, GROUP_A, LOCATION_A)];
      const names = await w.service.resolveLocationNames(KG, events);
      expect(names.get(LOCATION_A)).toBe('Музыкальный зал');
    });

    it('skips events with a null locationId (no map entry)', async () => {
      const w = wire();
      const events = [makeEvent(KG, EV_1, GROUP_A, null)];
      const names = await w.service.resolveLocationNames(KG, events);
      expect(names.size).toBe(0);
    });

    it('maps to null when the location is not found', async () => {
      const w = wire();
      // No location seeded for LOCATION_A.
      const events = [makeEvent(KG, EV_1, GROUP_A, LOCATION_A)];
      const names = await w.service.resolveLocationNames(KG, events);
      expect(names.get(LOCATION_A)).toBeNull();
    });

    it('maps to null when the location name is blank/whitespace', async () => {
      const w = wire();
      w.locationRepo.put(makeLocation(KG, LOCATION_A, '   '));
      const events = [makeEvent(KG, EV_1, GROUP_A, LOCATION_A)];
      const names = await w.service.resolveLocationNames(KG, events);
      expect(names.get(LOCATION_A)).toBeNull();
    });

    it('maps to null for a cross-tenant location (tenant-scoped lookup)', async () => {
      const w = wire();
      // Location belongs to a different KG.
      w.locationRepo.put(makeLocation(KG_OTHER, LOCATION_A, 'Чужой зал'));
      const events = [makeEvent(KG, EV_1, GROUP_A, LOCATION_A)];
      const names = await w.service.resolveLocationNames(KG, events);
      expect(names.get(LOCATION_A)).toBeNull();
    });

    it('dedups distinct locationIds across multiple events', async () => {
      const w = wire();
      w.locationRepo.put(makeLocation(KG, LOCATION_A, 'Зал А'));
      w.locationRepo.put(makeLocation(KG, LOCATION_B, 'Зал Б'));
      const events = [
        makeEvent(KG, EV_1, GROUP_A, LOCATION_A),
        makeEvent(KG, EV_2, GROUP_A, LOCATION_A),
        makeEvent(KG, randomUuidLike('e3'), GROUP_A, LOCATION_B),
      ];
      const names = await w.service.resolveLocationNames(KG, events);
      expect(names.size).toBe(2);
      expect(names.get(LOCATION_A)).toBe('Зал А');
      expect(names.get(LOCATION_B)).toBe('Зал Б');
    });

    it('returns an empty map when the LocationRepository is not wired (fail-closed)', async () => {
      const w = wire(false);
      w.locationRepo.put(makeLocation(KG, LOCATION_A, 'Зал А'));
      const events = [makeEvent(KG, EV_1, GROUP_A, LOCATION_A)];
      const names = await w.service.resolveLocationNames(KG, events);
      expect(names.size).toBe(0);
    });
  });

  describe('resolveLocationName (single event overlay)', () => {
    const EV_1 = 'e1111111-1111-1111-1111-111111111111';

    it('resolves the name for an event with a locationId', async () => {
      const w = wire();
      w.locationRepo.put(makeLocation(KG, LOCATION_A, 'Спортзал'));
      const event = makeEvent(KG, EV_1, GROUP_A, LOCATION_A);
      expect(await w.service.resolveLocationName(KG, event)).toBe('Спортзал');
    });

    it('returns null when the event has no locationId', async () => {
      const w = wire();
      const event = makeEvent(KG, EV_1, GROUP_A, null);
      expect(await w.service.resolveLocationName(KG, event)).toBeNull();
    });

    it('returns null when the location is not found', async () => {
      const w = wire();
      const event = makeEvent(KG, EV_1, GROUP_A, LOCATION_A);
      expect(await w.service.resolveLocationName(KG, event)).toBeNull();
    });

    it('returns null when the LocationRepository is not wired (fail-closed)', async () => {
      const w = wire(false);
      w.locationRepo.put(makeLocation(KG, LOCATION_A, 'Спортзал'));
      const event = makeEvent(KG, EV_1, GROUP_A, LOCATION_A);
      expect(await w.service.resolveLocationName(KG, event)).toBeNull();
    });
  });
});

/** Deterministic UUID-shaped id from a short prefix (test convenience). */
function randomUuidLike(prefix: string): string {
  const base = prefix.padEnd(8, '0').slice(0, 8);
  return `${base}-0000-0000-0000-000000000000`;
}
