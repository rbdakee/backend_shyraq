/**
 * TimelineService — service-unit suite. Hand-written in-memory fakes for
 * every collaborator (no Jest auto-mock).
 *
 * Coverage matrix:
 *   - createEntry happy path: row inserted, notify emitted, returns entry.
 *   - createEntry with reserved entry_type → throws InvalidTimelineEntryTypeError.
 *   - updateEntry non-admin author: succeeds.
 *   - updateEntry non-admin non-author → throws TimelineEntryNotAuthorError.
 *   - updateEntry admin non-author: succeeds.
 *   - deleteEntry author: row removed.
 *   - deleteEntry non-author non-admin → throws TimelineEntryNotAuthorError.
 *   - listByChild: returns entries ordered by entryTime DESC (most recent first).
 *
 * Test names use `it('returns ...')` / `it('throws ...')` / `it('rejects ...')`
 * per CLAUDE.md §7. NO `it('should ...')`.
 */
import {
  NotificationPort,
  GuardianApprovedEvent,
  GuardianPendingApprovalEvent,
  GuardianRejectedEvent,
  GuardianRevokedEvent,
  ChildTransferredEvent,
  PermissionsUpdatedEvent,
  AttendanceCheckInEvent,
  AttendanceCheckOutEvent,
  DailyStatusChangedEvent,
  TimelineEntryCreatedEvent,
} from '@/common/notifications/notification.port';
import { Child } from '@/modules/child/domain/entities/child.entity';
import { ChildNotFoundError } from '@/modules/child/domain/errors/child-not-found.error';
import {
  ChildGroupHistoryRecord,
  ChildListFilters,
  ChildRepository,
  PageRequest,
  PageResult,
} from '@/modules/child/infrastructure/persistence/child.repository';
import {
  GroupRepository,
  CreateGroupInput,
  ListGroupsFilters,
  UpdateGroupInput,
} from '@/modules/group/infrastructure/persistence/group.repository';
import { Group } from '@/modules/group/domain/entities/group.entity';
import { GroupMentor } from '@/modules/group/domain/entities/group-mentor.entity';
import { StaffMember } from '@/modules/staff/domain/entities/staff-member.entity';
import { StaffNotFoundError } from '@/modules/staff/domain/errors/staff-not-found.error';
import {
  CreateStaffMemberInput,
  ListStaffFilters,
  StaffMemberRepository,
  UpdateStaffMemberInput,
} from '@/modules/staff/infrastructure/persistence/staff-member.repository';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { TimelineEntry } from './domain/entities/timeline-entry.entity';
import { InvalidAttendanceTimestampError } from './domain/errors/invalid-attendance-timestamp.error';
import { InvalidTimelineEntryTypeError } from './domain/errors/invalid-timeline-entry-type.error';
import { MentorScopeViolatedError } from './domain/errors/mentor-scope-violated.error';
import { TimelineEntryNotAuthorError } from './domain/errors/timeline-entry-not-author.error';
import { TimelineEntryNotFoundError } from './domain/errors/timeline-entry-not-found.error';
import {
  ListTimelineEntriesFilter,
  PagedTimelineEntries,
  TimelineEntryRepository,
} from './infrastructure/persistence/timeline-entry.repository';
import { TimelineService } from './timeline.service';

// ── Constants ────────────────────────────────────────────────────────────

const KG = '22222222-2222-2222-2222-222222222222';
const CHILD = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const STAFF_USER = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa';
const STAFF_ID = 'bbbbbbbb-1111-1111-1111-bbbbbbbbbbbb';
const OTHER_STAFF_USER = 'aaaaaaaa-3333-3333-3333-aaaaaaaaaaaa';
const OTHER_STAFF_ID = 'bbbbbbbb-3333-3333-3333-bbbbbbbbbbbb';
const GROUP_ID = 'gggggggg-gggg-gggg-gggg-gggggggggggg';
const NOW = new Date('2026-05-01T09:00:00.000Z');

// ── Fakes ────────────────────────────────────────────────────────────────

class FixedClock extends ClockPort {
  constructor(private fixed: Date) {
    super();
  }
  now(): Date {
    return this.fixed;
  }
}

class FakeTimelineRepo extends TimelineEntryRepository {
  rows = new Map<string, TimelineEntry>();

  create(_kg: string, t: TimelineEntry): Promise<TimelineEntry> {
    this.rows.set(t.id, t);
    return Promise.resolve(t);
  }

  findById(_kg: string, id: string): Promise<TimelineEntry | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }

  findByChild(
    _kg: string,
    _childId: string,
    _opts: ListTimelineEntriesFilter,
  ): Promise<PagedTimelineEntries> {
    const items = [...this.rows.values()].sort(
      (a, b) => b.entryTime.getTime() - a.entryTime.getTime(),
    );
    return Promise.resolve({ items, nextCursor: null });
  }

  update(_kg: string, t: TimelineEntry): Promise<TimelineEntry> {
    this.rows.set(t.id, t);
    return Promise.resolve(t);
  }

  delete(_kg: string, id: string): Promise<void> {
    this.rows.delete(id);
    return Promise.resolve();
  }
}

class FakeChildRepo extends ChildRepository {
  byId = new Map<string, Child>();
  put(c: Child): void {
    this.byId.set(c.id, c);
  }
  create(_c: Child): Promise<void> {
    return Promise.resolve();
  }
  findById(kg: string, id: string): Promise<Child | null> {
    const c = this.byId.get(id);
    if (!c || c.kindergartenId !== kg) return Promise.resolve(null);
    return Promise.resolve(c);
  }
  findByKindergartenAndIin(_kg: string, _iin: string): Promise<Child | null> {
    return Promise.resolve(null);
  }
  update(_c: Child): Promise<void> {
    return Promise.resolve();
  }
  list(
    _kg: string,
    _f: ChildListFilters,
    _p: PageRequest,
  ): Promise<PageResult<Child>> {
    return Promise.resolve({ items: [], total: 0 });
  }
  countActiveByGroup(_kg: string, _gid: string): Promise<number> {
    return Promise.resolve(0);
  }
  recordGroupTransfer(): Promise<void> {
    return Promise.resolve();
  }
  listGroupHistory(): Promise<ChildGroupHistoryRecord[]> {
    return Promise.resolve([]);
  }
  findByIinCrossTenant(): Promise<Child[]> {
    return Promise.resolve([]);
  }
  findByIdsCrossTenant(): Promise<Child[]> {
    return Promise.resolve([]);
  }
}

class FakeStaffRepo extends StaffMemberRepository {
  rows = new Map<string, StaffMember>();
  put(s: StaffMember): void {
    this.rows.set(`${s.kindergartenId}|${s.userId}`, s);
  }
  create(_input: CreateStaffMemberInput): Promise<StaffMember> {
    throw new Error('not used');
  }
  findById(_kg: string, _id: string): Promise<StaffMember | null> {
    return Promise.resolve(null);
  }
  findActiveByUserAndKindergarten(
    userId: string,
    kg: string,
  ): Promise<StaffMember | null> {
    return Promise.resolve(this.rows.get(`${kg}|${userId}`) ?? null);
  }
  findByUserAndKindergarten(
    _userId: string,
    _kg: string,
  ): Promise<StaffMember | null> {
    return Promise.resolve(null);
  }
  listByKindergarten(
    _kg: string,
    _f?: ListStaffFilters,
  ): Promise<StaffMember[]> {
    return Promise.resolve([]);
  }
  update(
    _kg: string,
    _id: string,
    _patch: UpdateStaffMemberInput,
  ): Promise<StaffMember | null> {
    return Promise.resolve(null);
  }
  save(s: StaffMember): Promise<StaffMember> {
    return Promise.resolve(s);
  }
  deactivateAllByKindergarten(): Promise<number> {
    return Promise.resolve(0);
  }
  findAllActiveByUserId(): Promise<StaffMember[]> {
    return Promise.resolve([]);
  }
}

class FakeNotificationPort extends NotificationPort {
  timelines: TimelineEntryCreatedEvent[] = [];

  notifyGuardianPendingApproval(
    _e: GuardianPendingApprovalEvent,
  ): Promise<void> {
    return Promise.resolve();
  }
  notifyGuardianApproved(_e: GuardianApprovedEvent): Promise<void> {
    return Promise.resolve();
  }
  notifyGuardianRejected(_e: GuardianRejectedEvent): Promise<void> {
    return Promise.resolve();
  }
  notifyGuardianRevoked(_e: GuardianRevokedEvent): Promise<void> {
    return Promise.resolve();
  }
  notifyChildTransferred(_e: ChildTransferredEvent): Promise<void> {
    return Promise.resolve();
  }
  notifyPermissionsUpdated(_e: PermissionsUpdatedEvent): Promise<void> {
    return Promise.resolve();
  }
  notifyAttendanceCheckIn(_e: AttendanceCheckInEvent): Promise<void> {
    return Promise.resolve();
  }
  notifyAttendanceCheckOut(_e: AttendanceCheckOutEvent): Promise<void> {
    return Promise.resolve();
  }
  notifyDailyStatusChanged(_e: DailyStatusChangedEvent): Promise<void> {
    return Promise.resolve();
  }
  notifyTimelineEntryCreated(e: TimelineEntryCreatedEvent): Promise<void> {
    this.timelines.push(e);
    return Promise.resolve();
  }
  notifyGuardianSelfRevoked(): Promise<void> {
    return Promise.resolve();
  }
  notifyPickupOtpSent(): Promise<void> {
    return Promise.resolve();
  }
  notifyPickupValidated(): Promise<void> {
    return Promise.resolve();
  }
  notifyParentRequestAccepted(): Promise<void> {
    return Promise.resolve();
  }
  notifyParentRequestRejected(): Promise<void> {
    return Promise.resolve();
  }
  notifyParentRequestCancelled(): Promise<void> {
    return Promise.resolve();
  }
  notifyParentRequestMessageSent(): Promise<void> {
    return Promise.resolve();
  }
  notifyInvoiceCreated(): Promise<void> {
    return Promise.resolve();
  }
  notifyInvoicePaid(): Promise<void> {
    return Promise.resolve();
  }
  notifyInvoiceOverdue(): Promise<void> {
    return Promise.resolve();
  }
  notifyInvoiceCancelled(): Promise<void> {
    return Promise.resolve();
  }
  notifyPaymentCompleted(): Promise<void> {
    return Promise.resolve();
  }
  notifyPaymentFailed(): Promise<void> {
    return Promise.resolve();
  }
  notifyPaymentRefunded(): Promise<void> {
    return Promise.resolve();
  }
  notifyRefundProcessed(): Promise<void> {
    return Promise.resolve();
  }
  notifyEnrollmentFirstInvoiceSkipped(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeGroupRepo extends GroupRepository {
  /**
   * Map of `userId` → Set of groupIds the user is the active mentor of.
   * Set via `setMentorForGroups` in tests.
   */
  mentorships = new Map<string, Set<string>>();

  setMentorForGroups(userId: string, groupIds: string[]): void {
    this.mentorships.set(userId, new Set(groupIds));
  }

  create(_kg: string, _i: CreateGroupInput): Promise<Group> {
    return Promise.reject(new Error('not used'));
  }
  findById(): Promise<Group | null> {
    return Promise.resolve(null);
  }
  list(_kg: string, _f?: ListGroupsFilters): Promise<Group[]> {
    return Promise.resolve([]);
  }
  update(
    _kg: string,
    _id: string,
    _p: UpdateGroupInput,
  ): Promise<Group | null> {
    return Promise.resolve(null);
  }
  save(g: Group): Promise<Group> {
    return Promise.resolve(g);
  }
  assignMentor(): Promise<GroupMentor> {
    return Promise.reject(new Error('not used'));
  }
  unassignMentor(): Promise<GroupMentor | null> {
    return Promise.resolve(null);
  }
  unassignMentorByStaffMember(): Promise<number> {
    return Promise.resolve(0);
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
  isUserActiveMentorForGroup(
    _kg: string,
    userId: string,
    groupId: string,
  ): Promise<boolean> {
    const groups = this.mentorships.get(userId);
    return Promise.resolve(groups?.has(groupId) ?? false);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function makeChild(currentGroupId: string | null = null): Child {
  return Child.hydrate({
    id: CHILD,
    kindergartenId: KG,
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

function makeStaff(userId: string, staffId: string): StaffMember {
  return StaffMember.hydrate({
    id: staffId,
    kindergartenId: KG,
    userId,
    fullName: 'Test Staff',
    phone: '+77770000001',
    role: 'mentor',
    specialistType: null,
    isActive: true,
    hiredAt: NOW,
    firedAt: null,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

interface Wired {
  service: TimelineService;
  timelineRepo: FakeTimelineRepo;
  childRepo: FakeChildRepo;
  staffRepo: FakeStaffRepo;
  groupRepo: FakeGroupRepo;
  notifications: FakeNotificationPort;
  clock: FixedClock;
}

function wire(childGroupId: string | null = null): Wired {
  const timelineRepo = new FakeTimelineRepo();
  const childRepo = new FakeChildRepo();
  const staffRepo = new FakeStaffRepo();
  const groupRepo = new FakeGroupRepo();
  const notifications = new FakeNotificationPort();
  const clock = new FixedClock(NOW);

  childRepo.put(makeChild(childGroupId));
  staffRepo.put(makeStaff(STAFF_USER, STAFF_ID));
  staffRepo.put(makeStaff(OTHER_STAFF_USER, OTHER_STAFF_ID));

  const service = new TimelineService(
    timelineRepo,
    childRepo,
    staffRepo,
    groupRepo,
    clock,
    notifications,
  );
  return {
    service,
    timelineRepo,
    childRepo,
    staffRepo,
    groupRepo,
    notifications,
    clock,
  };
}

/** No-op helper kept for test readability — notifications are now synchronous
 * awaits inside the service, so there is no microtask to flush. */
async function flushMicrotasks(): Promise<void> {
  // intentionally empty — notifications are synchronous outbox writes now
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('TimelineService — service-unit', () => {
  describe('createEntry', () => {
    it('returns the created entry and emits notifyTimelineEntryCreated', async () => {
      const w = wire();
      const entry = await w.service.createEntry(KG, CHILD, STAFF_USER, {
        entryType: 'activity',
        title: 'Morning exercise',
        body: 'Kids did stretching.',
      });
      expect(entry.entryType.value).toBe('activity');
      expect(entry.title).toBe('Morning exercise');
      expect(entry.recordedBy).toBe(STAFF_ID);
      expect(w.timelineRepo.rows.size).toBe(1);
      await flushMicrotasks();
      expect(w.notifications.timelines).toHaveLength(1);
      expect(w.notifications.timelines[0].entryType).toBe('activity');
      expect(w.notifications.timelines[0].childId).toBe(CHILD);
    });

    it('throws InvalidTimelineEntryTypeError when entryType is check_in', async () => {
      const w = wire();
      await expect(
        w.service.createEntry(KG, CHILD, STAFF_USER, { entryType: 'check_in' }),
      ).rejects.toBeInstanceOf(InvalidTimelineEntryTypeError);
      expect(w.timelineRepo.rows.size).toBe(0);
    });

    it('throws InvalidTimelineEntryTypeError when entryType is check_out', async () => {
      const w = wire();
      await expect(
        w.service.createEntry(KG, CHILD, STAFF_USER, {
          entryType: 'check_out',
        }),
      ).rejects.toBeInstanceOf(InvalidTimelineEntryTypeError);
    });

    it('throws ChildNotFoundError when the child does not exist', async () => {
      const w = wire();
      await expect(
        w.service.createEntry(
          KG,
          'dddddddd-dddd-dddd-dddd-dddddddddddd',
          STAFF_USER,
          {
            entryType: 'note',
          },
        ),
      ).rejects.toBeInstanceOf(ChildNotFoundError);
    });

    it('throws StaffNotFoundError when caller has no active staff record', async () => {
      const w = wire();
      await expect(
        w.service.createEntry(KG, CHILD, 'no-such-user', { entryType: 'note' }),
      ).rejects.toBeInstanceOf(StaffNotFoundError);
    });
  });

  describe('updateEntry', () => {
    it('returns the updated entry when caller is the author (non-admin)', async () => {
      const w = wire();
      const entry = await w.service.createEntry(KG, CHILD, STAFF_USER, {
        entryType: 'note',
        title: 'Original',
      });
      const updated = await w.service.updateEntry(
        KG,
        entry.id,
        STAFF_USER,
        { title: 'Updated title' },
        { isAdmin: false },
      );
      expect(updated.title).toBe('Updated title');
    });

    it('throws TimelineEntryNotAuthorError when non-admin caller is not the author', async () => {
      const w = wire();
      const entry = await w.service.createEntry(KG, CHILD, STAFF_USER, {
        entryType: 'note',
      });
      // OTHER_STAFF_USER is a different staff member.
      await expect(
        w.service.updateEntry(
          KG,
          entry.id,
          OTHER_STAFF_USER,
          { title: 'Hijacked' },
          { isAdmin: false },
        ),
      ).rejects.toBeInstanceOf(TimelineEntryNotAuthorError);
    });

    it('returns the updated entry when caller is admin (ignores authorship)', async () => {
      const w = wire();
      const entry = await w.service.createEntry(KG, CHILD, STAFF_USER, {
        entryType: 'note',
        title: 'Original',
      });
      // OTHER_STAFF_USER is not the author but has isAdmin=true.
      const updated = await w.service.updateEntry(
        KG,
        entry.id,
        OTHER_STAFF_USER,
        { title: 'Admin override' },
        { isAdmin: true },
      );
      expect(updated.title).toBe('Admin override');
    });

    it('throws TimelineEntryNotFoundError when the entry does not exist', async () => {
      const w = wire();
      await expect(
        w.service.updateEntry(
          KG,
          'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
          STAFF_USER,
          { title: 'x' },
          { isAdmin: true },
        ),
      ).rejects.toBeInstanceOf(TimelineEntryNotFoundError);
    });
  });

  describe('deleteEntry', () => {
    it('removes the row when the caller is the author', async () => {
      const w = wire();
      const entry = await w.service.createEntry(KG, CHILD, STAFF_USER, {
        entryType: 'photo',
      });
      expect(w.timelineRepo.rows.size).toBe(1);
      await w.service.deleteEntry(KG, entry.id, STAFF_USER, { isAdmin: false });
      expect(w.timelineRepo.rows.size).toBe(0);
    });

    it('throws TimelineEntryNotAuthorError when non-admin caller is not the author', async () => {
      const w = wire();
      const entry = await w.service.createEntry(KG, CHILD, STAFF_USER, {
        entryType: 'photo',
      });
      await expect(
        w.service.deleteEntry(KG, entry.id, OTHER_STAFF_USER, {
          isAdmin: false,
        }),
      ).rejects.toBeInstanceOf(TimelineEntryNotAuthorError);
      // Row must still exist.
      expect(w.timelineRepo.rows.size).toBe(1);
    });
  });

  describe('listByChild', () => {
    it('returns entries ordered by entryTime DESC (most recent first)', async () => {
      const w = wire();
      // Both entries strictly in the past so assertNotFuture allows them.
      const earlier = new Date('2026-05-01T07:00:00.000Z');
      const later = new Date('2026-05-01T08:30:00.000Z');

      await w.service.createEntry(KG, CHILD, STAFF_USER, {
        entryType: 'activity',
        entryTime: earlier.toISOString(),
      });
      await w.service.createEntry(KG, CHILD, STAFF_USER, {
        entryType: 'meal',
        entryTime: later.toISOString(),
      });

      const result = await w.service.listByChild(KG, CHILD, { limit: 10 });
      expect(result.items).toHaveLength(2);
      // Most recent first.
      expect(result.items[0].entryType.value).toBe('meal');
      expect(result.items[1].entryType.value).toBe('activity');
    });

    it('throws ChildNotFoundError when the child does not exist', async () => {
      const w = wire();
      await expect(
        w.service.listByChild(KG, 'dddddddd-dddd-dddd-dddd-dddddddddddd', {}),
      ).rejects.toBeInstanceOf(ChildNotFoundError);
    });
  });

  // ── T7 fix-pass: M3 — future-dated entryTime rejection ───────────────────

  describe('M3 — assertNotFuture guard', () => {
    it('rejects createEntry with entryTime > now + 5min skew', async () => {
      const w = wire();
      const futureTime = new Date(NOW.getTime() + 60 * 60 * 1000); // +1h
      await expect(
        w.service.createEntry(KG, CHILD, STAFF_USER, {
          entryType: 'note',
          entryTime: futureTime.toISOString(),
        }),
      ).rejects.toBeInstanceOf(InvalidAttendanceTimestampError);
    });

    it('rejects updateEntry with patched entryTime in the future', async () => {
      const w = wire();
      const entry = await w.service.createEntry(KG, CHILD, STAFF_USER, {
        entryType: 'note',
      });
      const futureTime = new Date(NOW.getTime() + 60 * 60 * 1000);
      await expect(
        w.service.updateEntry(
          KG,
          entry.id,
          STAFF_USER,
          { entryTime: futureTime.toISOString() },
          { isAdmin: false },
        ),
      ).rejects.toBeInstanceOf(InvalidAttendanceTimestampError);
    });
  });

  // ── B22b T13 — mentor-group scope ─────────────────────────────────────────

  describe('mentor-group scope (B22b T13)', () => {
    it('throws MentorScopeViolatedError when child has no group', async () => {
      // Child has currentGroupId=null — mentor cannot claim scope.
      const w = wire(null);
      w.groupRepo.setMentorForGroups(STAFF_USER, [GROUP_ID]);
      await expect(
        w.service.createEntry(
          KG,
          CHILD,
          STAFF_USER,
          { entryType: 'note' },
          { isAdmin: false, callerRole: 'mentor' },
        ),
      ).rejects.toBeInstanceOf(MentorScopeViolatedError);
    });

    it('throws MentorScopeViolatedError when mentor is not assigned to the child group', async () => {
      // Child is in GROUP_ID but STAFF_USER is not the active mentor there.
      const w = wire(GROUP_ID);
      // No mentorship set → isUserActiveMentorForGroup returns false.
      await expect(
        w.service.createEntry(
          KG,
          CHILD,
          STAFF_USER,
          { entryType: 'note' },
          { isAdmin: false, callerRole: 'mentor' },
        ),
      ).rejects.toBeInstanceOf(MentorScopeViolatedError);
    });

    it('returns created entry when mentor is assigned to the child group', async () => {
      const w = wire(GROUP_ID);
      w.groupRepo.setMentorForGroups(STAFF_USER, [GROUP_ID]);
      const entry = await w.service.createEntry(
        KG,
        CHILD,
        STAFF_USER,
        { entryType: 'activity', title: 'Group activity' },
        { isAdmin: false, callerRole: 'mentor' },
      );
      expect(entry.entryType.value).toBe('activity');
      expect(w.timelineRepo.rows.size).toBe(1);
    });

    it('bypasses mentor-group scope when isAdmin=true', async () => {
      // Admin may write for any child regardless of mentor assignment.
      const w = wire(GROUP_ID);
      // No mentorship set — but isAdmin=true so scope is not checked.
      const entry = await w.service.createEntry(
        KG,
        CHILD,
        STAFF_USER,
        { entryType: 'note', title: 'Admin note' },
        { isAdmin: true, callerRole: 'mentor' },
      );
      expect(entry.entryType.value).toBe('note');
    });

    it('bypasses mentor-group scope for non-mentor roles (specialist)', async () => {
      // Specialist role is kg-scoped, not group-scoped — no check applied.
      const w = wire(GROUP_ID);
      // No mentorship set but callerRole=specialist → no scope check.
      const entry = await w.service.createEntry(
        KG,
        CHILD,
        STAFF_USER,
        { entryType: 'note', title: 'Specialist note' },
        { isAdmin: false, callerRole: 'specialist' },
      );
      expect(entry.entryType.value).toBe('note');
    });

    it('throws MentorScopeViolatedError on deleteEntry when mentor is not in child group', async () => {
      const w = wire(GROUP_ID);
      // Create entry as admin so we bypass scope on create.
      const entry = await w.service.createEntry(
        KG,
        CHILD,
        STAFF_USER,
        { entryType: 'photo' },
        { isAdmin: true },
      );
      // Now try to delete as a mentor not assigned to the child's group.
      await expect(
        w.service.deleteEntry(KG, entry.id, STAFF_USER, {
          isAdmin: false,
          callerRole: 'mentor',
        }),
      ).rejects.toBeInstanceOf(MentorScopeViolatedError);
      expect(w.timelineRepo.rows.size).toBe(1);
    });
  });
});
