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
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { ActivityEvent } from './domain/entities/activity-event.entity';
import { ScheduleTemplate } from './domain/entities/schedule-template.entity';
import { ScheduleWeekSnapshot } from './domain/entities/schedule-week-snapshot.entity';
import { ActivityEventNotFoundError } from './domain/errors/activity-event-not-found.error';
import { EventNotDeletableError } from './domain/errors/event-not-deletable.error';
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
    _filter: ListScheduleWeekSnapshotsFilter,
  ): Promise<ScheduleWeekSnapshot[]> {
    return Promise.resolve(this.rows.filter((r) => r.kindergartenId === kg));
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
  findActiveMentor(_kg: string, _gid: string): Promise<GroupMentor | null> {
    throw new Error('not used');
  }
  listMentorHistory(_kg: string, _gid: string): Promise<GroupMentor[]> {
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
}

// ── helpers ──────────────────────────────────────────────────────────────

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
}

function wire(): Wired {
  const templateRepo = new FakeScheduleTemplateRepo();
  const eventRepo = new FakeActivityEventRepo();
  const snapshotRepo = new FakeWeekSnapshotRepo();
  const groupRepo = new FakeGroupRepo();
  const childRepo = new FakeChildRepo();
  const clock = new FixedClock(NOW);
  const service = new ScheduleService(
    templateRepo,
    eventRepo,
    snapshotRepo,
    groupRepo,
    childRepo,
    clock,
  );
  return {
    service,
    templateRepo,
    eventRepo,
    snapshotRepo,
    groupRepo,
    childRepo,
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
      expect(monEvent.startsAt.toISOString()).toBe('2026-05-04T09:00:00.000Z');
      expect(tueEvent.startsAt.toISOString()).toBe('2026-05-05T10:00:00.000Z');
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
});
