/**
 * AttendanceService — service-unit suite. Hand-written in-memory fakes for
 * every collaborator (no Jest auto-mock).
 *
 * Coverage matrix:
 *   - checkIn happy path: writes 3 rows + emits notifyAttendanceCheckIn.
 *   - checkIn idempotent on existing 'present' daily_status (no-op on the
 *     status row; event + timeline still inserted).
 *   - checkIn preserves 'sick' daily_status (no promotion).
 *   - checkIn promotes 'absent' to 'present'.
 *   - checkOut happy path: writes 2 rows, no daily_status mutation.
 *   - checkOut rejects revoked/can_pickup=false/non-approved guardian → no
 *     rows written, no notification.
 *   - patchEvent: non-admin out-of-window → 403; admin out-of-window → ok.
 *   - setDailyStatus is upsert-idempotent and emits notifyDailyStatusChanged.
 *
 * Test names use `it('returns ...')` / `it('throws ...')` / `it('rejects ...')`
 * per CLAUDE.md §7. NO `it('should ...')`.
 */
import { randomUUID } from 'node:crypto';
import {
  AttendanceCheckInEvent,
  AttendanceCheckOutEvent,
  ChildTransferredEvent,
  DailyStatusChangedEvent,
  GuardianApprovedEvent,
  GuardianPendingApprovalEvent,
  GuardianRejectedEvent,
  GuardianRevokedEvent,
  NotificationPort,
  PermissionsUpdatedEvent,
  TimelineEntryCreatedEvent,
} from '@/common/notifications/notification.port';
import { Child } from '@/modules/child/domain/entities/child.entity';
import { ChildGuardian } from '@/modules/child/domain/entities/child-guardian.entity';
import { ChildNotFoundError } from '@/modules/child/domain/errors/child-not-found.error';
import { ChildGuardianRepository } from '@/modules/child/infrastructure/persistence/child-guardian.repository';
import {
  ChildGroupHistoryRecord,
  ChildListFilters,
  ChildRepository,
  PageRequest,
  PageResult,
} from '@/modules/child/infrastructure/persistence/child.repository';
import { StaffMember } from '@/modules/staff/domain/entities/staff-member.entity';
import { StaffNotFoundError } from '@/modules/staff/domain/errors/staff-not-found.error';
import {
  CreateStaffMemberInput,
  ListStaffFilters,
  StaffMemberRepository,
  UpdateStaffMemberInput,
} from '@/modules/staff/infrastructure/persistence/staff-member.repository';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { AttendanceService } from './attendance.service';
import { AttendanceEvent } from './domain/entities/attendance-event.entity';
import { ChildDailyStatus } from './domain/entities/child-daily-status.entity';
import { TimelineEntry } from './domain/entities/timeline-entry.entity';
import { AttendanceEditWindowExpiredError } from './domain/errors/attendance-edit-window-expired.error';
import { AttendanceEventNotFoundError } from './domain/errors/attendance-event-not-found.error';
import { InvalidAttendancePickupError } from './domain/errors/invalid-attendance-pickup.error';
import { InvalidAttendanceTimestampError } from './domain/errors/invalid-attendance-timestamp.error';
import { PickupUserNotAllowedError } from './domain/errors/pickup-user-not-allowed.error';
import { AttendanceMethod } from './domain/value-objects/attendance-method.vo';
import { ChildIntradayStatus } from './domain/value-objects/child-intraday-status.vo';
import {
  AttendanceEventRepository,
  ListAttendanceEventsByChildFilter,
  ListAttendanceEventsByGroupFilter,
  ListAttendanceEventsByKindergartenFilter,
} from './infrastructure/persistence/attendance-event.repository';
import {
  ChildDailyStatusRepository,
  ListDailyStatusFilter,
} from './infrastructure/persistence/child-daily-status.repository';
import {
  ListTimelineEntriesFilter,
  PagedTimelineEntries,
  TimelineEntryRepository,
} from './infrastructure/persistence/timeline-entry.repository';

// ── Constants ────────────────────────────────────────────────────────────

const KG = '11111111-1111-1111-1111-111111111111';
const CHILD = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const STAFF_USER = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa';
const STAFF_ID = 'bbbbbbbb-1111-1111-1111-bbbbbbbbbbbb';
const PICKUP_USER = 'aaaaaaaa-2222-2222-2222-aaaaaaaaaaaa';
const NOW = new Date('2026-05-01T09:00:00.000Z');

class FixedClock extends ClockPort {
  constructor(private fixed: Date) {
    super();
  }
  now(): Date {
    return this.fixed;
  }
  set(d: Date): void {
    this.fixed = d;
  }
}

// ── Fakes ────────────────────────────────────────────────────────────────

class FakeAttendanceEventRepo extends AttendanceEventRepository {
  rows = new Map<string, AttendanceEvent>();
  byChildId = new Map<string, AttendanceEvent[]>();

  create(kg: string, e: AttendanceEvent): Promise<AttendanceEvent> {
    if (e.kindergartenId !== kg) throw new Error('kg mismatch');
    this.rows.set(e.id, e);
    const list = this.byChildId.get(e.childId) ?? [];
    list.push(e);
    this.byChildId.set(e.childId, list);
    return Promise.resolve(e);
  }
  findById(kg: string, id: string): Promise<AttendanceEvent | null> {
    const e = this.rows.get(id);
    if (!e || e.kindergartenId !== kg) return Promise.resolve(null);
    return Promise.resolve(e);
  }
  update(kg: string, e: AttendanceEvent): Promise<AttendanceEvent> {
    if (!this.rows.has(e.id)) throw new Error('row missing');
    if (e.kindergartenId !== kg) throw new Error('kg mismatch');
    this.rows.set(e.id, e);
    return Promise.resolve(e);
  }
  listByChild(
    kg: string,
    childId: string,
    _filter: ListAttendanceEventsByChildFilter,
  ): Promise<AttendanceEvent[]> {
    const list = (this.byChildId.get(childId) ?? []).filter(
      (e) => e.kindergartenId === kg,
    );
    return Promise.resolve(list);
  }
  listByGroup(
    kg: string,
    _filter: ListAttendanceEventsByGroupFilter,
  ): Promise<AttendanceEvent[]> {
    return Promise.resolve(
      [...this.rows.values()].filter((e) => e.kindergartenId === kg),
    );
  }
  listByKindergarten(
    kg: string,
    _filter: ListAttendanceEventsByKindergartenFilter,
  ): Promise<AttendanceEvent[]> {
    return Promise.resolve(
      [...this.rows.values()].filter((e) => e.kindergartenId === kg),
    );
  }
}

class FakeChildDailyStatusRepo extends ChildDailyStatusRepository {
  rows: ChildDailyStatus[] = [];

  put(d: ChildDailyStatus): void {
    this.rows.push(d);
  }
  findByChildAndDate(
    kg: string,
    childId: string,
    date: string,
  ): Promise<ChildDailyStatus | null> {
    const r =
      this.rows.find(
        (x) =>
          x.kindergartenId === kg && x.childId === childId && x.date === date,
      ) ?? null;
    return Promise.resolve(r);
  }
  upsert(kg: string, daily: ChildDailyStatus): Promise<ChildDailyStatus> {
    const idx = this.rows.findIndex(
      (x) =>
        x.kindergartenId === kg &&
        x.childId === daily.childId &&
        x.date === daily.date,
    );
    if (idx >= 0) this.rows[idx] = daily;
    else this.rows.push(daily);
    return Promise.resolve(daily);
  }
  save(kg: string, daily: ChildDailyStatus): Promise<ChildDailyStatus> {
    const idx = this.rows.findIndex(
      (x) => x.kindergartenId === kg && x.id === daily.id,
    );
    if (idx < 0) throw new Error('row missing');
    this.rows[idx] = daily;
    return Promise.resolve(daily);
  }
  /**
   * Test override: when set for a `${childId}@${date}`, force
   * `updatePresentIfAbsentOrLate` to short-circuit and report
   * `updated=false`. Mirrors the production behaviour when a concurrent
   * setter has flipped the row to a non-promotable status (sick /
   * on_vacation / etc.) between the service's read and write — the
   * conditional UPDATE returns 0 affected rows.
   */
  forceUpdateBlockedFor = new Set<string>();
  updatePresentIfAbsentOrLate(
    kg: string,
    childId: string,
    date: string,
    setBy: string | null,
    now: Date,
  ): Promise<{ updated: boolean; current: ChildDailyStatus | null }> {
    const key = `${childId}@${date}`;
    const idx = this.rows.findIndex(
      (x) =>
        x.kindergartenId === kg && x.childId === childId && x.date === date,
    );
    if (idx < 0) {
      return Promise.resolve({ updated: false, current: null });
    }
    const row = this.rows[idx];
    if (this.forceUpdateBlockedFor.has(key)) {
      return Promise.resolve({ updated: false, current: row });
    }
    // Mirror SQL: only `absent` and `late` are promotable.
    const promotable =
      row.status.value === 'absent' || row.status.value === 'late';
    if (!promotable) {
      return Promise.resolve({ updated: false, current: row });
    }
    row.markPresent(setBy, { now: () => now });
    return Promise.resolve({ updated: true, current: row });
  }
  /** Optional in-memory group lookup so tests can exercise groupId filtering. */
  childGroup = new Map<string, string | null>();
  list(kg: string, filter: ListDailyStatusFilter): Promise<ChildDailyStatus[]> {
    let items = this.rows.filter((x) => x.kindergartenId === kg);
    if (filter.childId) {
      items = items.filter((x) => x.childId === filter.childId);
    }
    if (filter.groupId) {
      items = items.filter(
        (x) => this.childGroup.get(x.childId) === filter.groupId,
      );
    }
    if (filter.from) {
      items = items.filter((x) => x.date >= filter.from!);
    }
    if (filter.to) {
      items = items.filter((x) => x.date <= filter.to!);
    }
    return Promise.resolve(items);
  }
}

class FakeTimelineRepo extends TimelineEntryRepository {
  rows = new Map<string, TimelineEntry>();
  create(kg: string, t: TimelineEntry): Promise<TimelineEntry> {
    if (t.kindergartenId !== kg) throw new Error('kg mismatch');
    this.rows.set(t.id, t);
    return Promise.resolve(t);
  }
  findById(kg: string, id: string): Promise<TimelineEntry | null> {
    const t = this.rows.get(id);
    if (!t || t.kindergartenId !== kg) return Promise.resolve(null);
    return Promise.resolve(t);
  }
  findByChild(
    _kg: string,
    _childId: string,
    _opts: ListTimelineEntriesFilter,
  ): Promise<PagedTimelineEntries> {
    return Promise.resolve({
      items: [...this.rows.values()],
      nextCursor: null,
    });
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

class FakeGuardianRepo extends ChildGuardianRepository {
  rows: ChildGuardian[] = [];
  put(g: ChildGuardian): void {
    this.rows.push(g);
  }
  create(_g: ChildGuardian): Promise<void> {
    return Promise.resolve();
  }
  findById(_kg: string, _id: string): Promise<ChildGuardian | null> {
    return Promise.resolve(null);
  }
  findByChildId(_kg: string, _cid: string): Promise<ChildGuardian[]> {
    return Promise.resolve([]);
  }
  findActiveByChildAndUser(): Promise<ChildGuardian | null> {
    return Promise.resolve(null);
  }
  findApprovedByChildAndUserCrossTenant(): Promise<ChildGuardian | null> {
    return Promise.resolve(null);
  }
  findByIdCrossTenant(): Promise<ChildGuardian | null> {
    return Promise.resolve(null);
  }
  findPendingForPrimary(): Promise<ChildGuardian[]> {
    return Promise.resolve([]);
  }
  update(_g: ChildGuardian): Promise<void> {
    return Promise.resolve();
  }
  countApprovalRights(): Promise<number> {
    return Promise.resolve(0);
  }
  acquireApprovalRightsLock(): Promise<void> {
    return Promise.resolve();
  }
  listApprovedKindergartenIdsByUserId(): Promise<string[]> {
    return Promise.resolve([]);
  }
  findApprovedByUser(): Promise<ChildGuardian[]> {
    return Promise.resolve([]);
  }
  findPendingPrimaryByUserIdCrossTenant(): Promise<ChildGuardian[]> {
    return Promise.resolve([]);
  }
  findApprovedActivePickupGuardian(
    kg: string,
    childId: string,
    userId: string,
  ): Promise<ChildGuardian | null> {
    const r =
      this.rows.find((g) => {
        const s = g.toState();
        return (
          s.kindergartenId === kg &&
          s.childId === childId &&
          s.userId === userId &&
          s.status === 'approved' &&
          s.revokedAt === null &&
          s.canPickup === true
        );
      }) ?? null;
    return Promise.resolve(r);
  }
  findApprovedActiveByUserIdCrossTenant(
    _userId: string,
  ): Promise<ChildGuardian[]> {
    return Promise.resolve([]);
  }
  findApprovedActiveByUserAndChild(): Promise<ChildGuardian | null> {
    return Promise.resolve(null);
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
    const r = this.rows.get(`${kg}|${userId}`) ?? null;
    return Promise.resolve(r);
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
  checkIns: AttendanceCheckInEvent[] = [];
  checkOuts: AttendanceCheckOutEvent[] = [];
  dailyStatusChanges: DailyStatusChangedEvent[] = [];
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
  notifyAttendanceCheckIn(e: AttendanceCheckInEvent): Promise<void> {
    this.checkIns.push(e);
    return Promise.resolve();
  }
  notifyAttendanceCheckOut(e: AttendanceCheckOutEvent): Promise<void> {
    this.checkOuts.push(e);
    return Promise.resolve();
  }
  notifyDailyStatusChanged(e: DailyStatusChangedEvent): Promise<void> {
    this.dailyStatusChanges.push(e);
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
}

// ── helpers ──────────────────────────────────────────────────────────────

function makeChild(): Child {
  return Child.hydrate({
    id: CHILD,
    kindergartenId: KG,
    iin: null,
    fullName: 'Test Child',
    dateOfBirth: new Date('2022-01-01'),
    gender: null,
    photoUrl: null,
    status: 'active',
    currentGroupId: null,
    enrollmentDate: NOW,
    archivedAt: null,
    archiveReason: null,
    medicalNotes: null,
    allergyNotes: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function makeStaff(): StaffMember {
  return StaffMember.hydrate({
    id: STAFF_ID,
    kindergartenId: KG,
    userId: STAFF_USER,
    fullName: 'Test Staff',
    phone: '+77770000000',
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

function makeApprovedPickupGuardian(
  overrides: {
    canPickup?: boolean;
    revokedAt?: Date | null;
    status?: 'approved' | 'pending_approval' | 'rejected' | 'revoked';
  } = {},
): ChildGuardian {
  return ChildGuardian.hydrate({
    id: randomUUID(),
    kindergartenId: KG,
    childId: CHILD,
    userId: PICKUP_USER,
    role: 'primary',
    status: overrides.status ?? 'approved',
    hasApprovalRights: true,
    approvedBy: PICKUP_USER,
    approvedAt: NOW,
    revokedBy: null,
    revokedAt: overrides.revokedAt ?? null,
    canPickup: overrides.canPickup ?? true,
    permissions: {},
    permissionsUpdatedBy: null,
    permissionsUpdatedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

interface Wired {
  service: AttendanceService;
  eventRepo: FakeAttendanceEventRepo;
  dailyRepo: FakeChildDailyStatusRepo;
  timelineRepo: FakeTimelineRepo;
  childRepo: FakeChildRepo;
  guardianRepo: FakeGuardianRepo;
  staffRepo: FakeStaffRepo;
  notifications: FakeNotificationPort;
  clock: FixedClock;
}

function wire(): Wired {
  const eventRepo = new FakeAttendanceEventRepo();
  const dailyRepo = new FakeChildDailyStatusRepo();
  const timelineRepo = new FakeTimelineRepo();
  const childRepo = new FakeChildRepo();
  const guardianRepo = new FakeGuardianRepo();
  const staffRepo = new FakeStaffRepo();
  const notifications = new FakeNotificationPort();
  const clock = new FixedClock(NOW);
  childRepo.put(makeChild());
  staffRepo.put(makeStaff());
  const service = new AttendanceService(
    eventRepo,
    dailyRepo,
    timelineRepo,
    childRepo,
    guardianRepo,
    staffRepo,
    clock,
    notifications,
  );
  return {
    service,
    eventRepo,
    dailyRepo,
    timelineRepo,
    childRepo,
    guardianRepo,
    staffRepo,
    notifications,
    clock,
  };
}

/** No-op helper kept for test readability — notifications are now synchronous
 * awaits inside the service, so there is no microtask to flush. Kept so that
 * tests can still call it without changes (it resolves immediately). */
async function flushMicrotasks(): Promise<void> {
  // intentionally empty — notifications are synchronous outbox writes now
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('AttendanceService — service-unit', () => {
  describe('checkIn', () => {
    it('returns event + dailyStatus + timeline and emits notifyAttendanceCheckIn', async () => {
      const w = wire();
      const result = await w.service.checkIn(KG, CHILD, STAFF_USER);
      expect(result.event.eventType.value).toBe('check_in');
      expect(result.event.method.value).toBe('manual');
      expect(result.event.recordedBy).toBe(STAFF_ID);
      expect(result.event.pickupUserId).toBeNull();
      expect(result.timelineEntry.entryType.value).toBe('check_in');
      expect(result.dailyStatus).not.toBeNull();
      expect(result.dailyStatus!.status.value).toBe('present');
      expect(w.eventRepo.rows.size).toBe(1);
      expect(w.timelineRepo.rows.size).toBe(1);
      expect(w.dailyRepo.rows).toHaveLength(1);
      await flushMicrotasks();
      expect(w.notifications.checkIns).toHaveLength(1);
      expect(w.notifications.checkIns[0].eventId).toBe(result.event.id);
      expect(w.notifications.timelines).toHaveLength(1);
    });

    it('returns the existing daily_status without overwriting when it is already present', async () => {
      const w = wire();
      // Pre-existing 'present' row for today.
      const isoDate = NOW.toLocaleDateString('en-CA', {
        timeZone: 'Asia/Almaty',
      });
      const existing = ChildDailyStatus.createNew(
        {
          id: randomUUID(),
          kindergartenId: KG,
          childId: CHILD,
          date: isoDate,
          status: ChildIntradayStatus.PRESENT,
          note: 'pre-existing',
          setBy: STAFF_ID,
        },
        w.clock,
      );
      w.dailyRepo.put(existing);
      await w.service.checkIn(KG, CHILD, STAFF_USER);
      // Still exactly one daily_status row, still 'present', note untouched.
      expect(w.dailyRepo.rows).toHaveLength(1);
      expect(w.dailyRepo.rows[0].status.value).toBe('present');
      expect(w.dailyRepo.rows[0].note).toBe('pre-existing');
      // Event + timeline still inserted.
      expect(w.eventRepo.rows.size).toBe(1);
      expect(w.timelineRepo.rows.size).toBe(1);
    });

    it('preserves a pre-existing sick daily_status (no promotion)', async () => {
      const w = wire();
      const isoDate = NOW.toLocaleDateString('en-CA', {
        timeZone: 'Asia/Almaty',
      });
      const sickRow = ChildDailyStatus.createNew(
        {
          id: randomUUID(),
          kindergartenId: KG,
          childId: CHILD,
          date: isoDate,
          status: ChildIntradayStatus.SICK,
          note: 'parent reported flu',
          setBy: STAFF_ID,
        },
        w.clock,
      );
      w.dailyRepo.put(sickRow);
      await w.service.checkIn(KG, CHILD, STAFF_USER);
      expect(w.dailyRepo.rows[0].status.value).toBe('sick');
      expect(w.dailyRepo.rows[0].note).toBe('parent reported flu');
    });

    it('promotes an absent daily_status to present', async () => {
      const w = wire();
      const isoDate = NOW.toLocaleDateString('en-CA', {
        timeZone: 'Asia/Almaty',
      });
      const absent = ChildDailyStatus.createNew(
        {
          id: randomUUID(),
          kindergartenId: KG,
          childId: CHILD,
          date: isoDate,
          status: ChildIntradayStatus.ABSENT,
          note: null,
          setBy: STAFF_ID,
        },
        w.clock,
      );
      w.dailyRepo.put(absent);
      const result = await w.service.checkIn(KG, CHILD, STAFF_USER);
      expect(result.dailyStatus!.status.value).toBe('present');
      expect(w.dailyRepo.rows).toHaveLength(1);
      expect(w.dailyRepo.rows[0].status.value).toBe('present');
    });

    it('does NOT throw and does NOT overwrite when concurrent setter blocked the conditional UPDATE', async () => {
      // Repo started with status=absent (which would be promotable), but
      // a concurrent setter is simulated by `forceUpdateBlockedFor` —
      // the conditional UPDATE returns 0 affected rows. Service must NOT
      // throw, must NOT call .save() (which would overwrite), and the
      // returned dailyStatus must reflect the unchanged in-DB state.
      const w = wire();
      const isoDate = NOW.toLocaleDateString('en-CA', {
        timeZone: 'Asia/Almaty',
      });
      const seeded = ChildDailyStatus.createNew(
        {
          id: randomUUID(),
          kindergartenId: KG,
          childId: CHILD,
          date: isoDate,
          status: ChildIntradayStatus.ABSENT,
          note: null,
          setBy: STAFF_ID,
        },
        w.clock,
      );
      w.dailyRepo.put(seeded);
      w.dailyRepo.forceUpdateBlockedFor.add(`${CHILD}@${isoDate}`);
      const result = await w.service.checkIn(KG, CHILD, STAFF_USER);
      // The check-in still returns the existing row's snapshot (the
      // service prefers `current` from the conditional UPDATE which the
      // fake returns unchanged). status stays `absent` — the service
      // did NOT overwrite it.
      expect(result.dailyStatus!.status.value).toBe('absent');
      expect(w.dailyRepo.rows[0].status.value).toBe('absent');
      // Event + timeline + notifications still recorded — check-in is
      // not aborted by the daily_status conflict.
      expect(w.eventRepo.rows.size).toBe(1);
      expect(w.timelineRepo.rows.size).toBe(1);
    });

    it('throws ChildNotFoundError when child does not exist in this kindergarten', async () => {
      const w = wire();
      await expect(
        w.service.checkIn(
          KG,
          'dddddddd-dddd-dddd-dddd-dddddddddddd',
          STAFF_USER,
        ),
      ).rejects.toBeInstanceOf(ChildNotFoundError);
    });

    it('throws StaffNotFoundError when caller has no active staff record', async () => {
      const w = wire();
      await expect(
        w.service.checkIn(KG, CHILD, 'no-such-user-uuid'),
      ).rejects.toBeInstanceOf(StaffNotFoundError);
    });
  });

  describe('checkOut', () => {
    it('returns event with pickup user and emits notifyAttendanceCheckOut', async () => {
      const w = wire();
      w.guardianRepo.put(makeApprovedPickupGuardian());
      const result = await w.service.checkOut(
        KG,
        CHILD,
        STAFF_USER,
        PICKUP_USER,
      );
      expect(result.event.eventType.value).toBe('check_out');
      expect(result.event.pickupUserId).toBe(PICKUP_USER);
      expect(result.dailyStatus).toBeNull();
      // No daily_status row written on check-out.
      expect(w.dailyRepo.rows).toHaveLength(0);
      // Event + timeline written.
      expect(w.eventRepo.rows.size).toBe(1);
      expect(w.timelineRepo.rows.size).toBe(1);
      await flushMicrotasks();
      expect(w.notifications.checkOuts).toHaveLength(1);
      expect(w.notifications.checkOuts[0].pickupUserId).toBe(PICKUP_USER);
    });

    it('rejects when pickup user is not an approved guardian (no rows written)', async () => {
      const w = wire();
      // No guardian row at all.
      await expect(
        w.service.checkOut(KG, CHILD, STAFF_USER, PICKUP_USER),
      ).rejects.toBeInstanceOf(PickupUserNotAllowedError);
      expect(w.eventRepo.rows.size).toBe(0);
      expect(w.timelineRepo.rows.size).toBe(0);
      await flushMicrotasks();
      expect(w.notifications.checkOuts).toHaveLength(0);
    });

    it('rejects when guardian has can_pickup=false', async () => {
      const w = wire();
      w.guardianRepo.put(makeApprovedPickupGuardian({ canPickup: false }));
      await expect(
        w.service.checkOut(KG, CHILD, STAFF_USER, PICKUP_USER),
      ).rejects.toBeInstanceOf(PickupUserNotAllowedError);
    });

    it('rejects when guardian is revoked', async () => {
      const w = wire();
      w.guardianRepo.put(
        makeApprovedPickupGuardian({
          revokedAt: NOW,
          status: 'revoked',
        }),
      );
      await expect(
        w.service.checkOut(KG, CHILD, STAFF_USER, PICKUP_USER),
      ).rejects.toBeInstanceOf(PickupUserNotAllowedError);
    });

    // ── B11 OTP-pickup branch ────────────────────────────────────────────

    it('returns event with method=otp_pickup and skips guardian validation when pickupRequestId is set', async () => {
      const w = wire();
      // Crucially — NO guardian row is seeded. The OTP-pickup branch must
      // not consult ChildGuardianRepository.findApprovedActivePickupGuardian
      // because the trusted-person whitelist + OTP already gated this.
      const result = await w.service.checkOut(KG, CHILD, STAFF_USER, null, {
        method: AttendanceMethod.OTP_PICKUP,
        pickupRequestId: 'pr-1',
      });
      expect(result.event.method.value).toBe('otp_pickup');
      expect(result.event.pickupUserId).toBeNull();
      expect(result.event.pickupRequestId).toBe('pr-1');
      // Notification carried both fields verbatim.
      expect(w.notifications.checkOuts).toHaveLength(1);
      expect(w.notifications.checkOuts[0].pickupUserId).toBeNull();
      expect(w.notifications.checkOuts[0].pickupRequestId).toBe('pr-1');
    });

    it('throws InvalidAttendancePickupError when pickupUserId AND pickupRequestId are both null (legacy path requires a userId)', async () => {
      const w = wire();
      await expect(
        w.service.checkOut(KG, CHILD, STAFF_USER, null),
      ).rejects.toBeInstanceOf(InvalidAttendancePickupError);
    });
  });

  describe('patchEvent', () => {
    it('returns the patched event when admin (no window check)', async () => {
      const w = wire();
      // Pre-create an event recorded yesterday.
      const yesterday = new Date(NOW.getTime() - 25 * 60 * 60 * 1000);
      const result = await w.service.checkIn(KG, CHILD, STAFF_USER, {
        recordedAt: yesterday,
      });
      // Now patch as admin.
      const patched = await w.service.patchEvent(
        KG,
        result.event.id,
        STAFF_USER,
        { notes: 'admin fix' },
        { isAdmin: true },
      );
      expect(patched.notes).toBe('admin fix');
    });

    it('throws AttendanceEditWindowExpiredError when non-admin patches a yesterday event', async () => {
      const w = wire();
      const yesterday = new Date(NOW.getTime() - 25 * 60 * 60 * 1000);
      const result = await w.service.checkIn(KG, CHILD, STAFF_USER, {
        recordedAt: yesterday,
      });
      await expect(
        w.service.patchEvent(
          KG,
          result.event.id,
          STAFF_USER,
          { notes: 'late edit' },
          { isAdmin: false },
        ),
      ).rejects.toBeInstanceOf(AttendanceEditWindowExpiredError);
    });

    it('returns the patched event for non-admin within the same calendar day', async () => {
      const w = wire();
      const result = await w.service.checkIn(KG, CHILD, STAFF_USER);
      const patched = await w.service.patchEvent(
        KG,
        result.event.id,
        STAFF_USER,
        { notes: 'corrected' },
        { isAdmin: false },
      );
      expect(patched.notes).toBe('corrected');
    });

    it('throws AttendanceEventNotFoundError when the event does not exist', async () => {
      const w = wire();
      await expect(
        w.service.patchEvent(
          KG,
          'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
          STAFF_USER,
          { notes: 'x' },
          { isAdmin: true },
        ),
      ).rejects.toBeInstanceOf(AttendanceEventNotFoundError);
    });

    it('throws InvalidAttendancePickupError when pickup_user_id is set on a check_in event', async () => {
      const w = wire();
      const result = await w.service.checkIn(KG, CHILD, STAFF_USER);
      await expect(
        w.service.patchEvent(
          KG,
          result.event.id,
          STAFF_USER,
          { pickupUserId: PICKUP_USER },
          { isAdmin: true },
        ),
      ).rejects.toBeInstanceOf(InvalidAttendancePickupError);
    });

    it('re-validates the new pickup user when changed on a check_out event', async () => {
      const w = wire();
      // Seed an approved pickup guardian for the original check-out.
      w.guardianRepo.put(makeApprovedPickupGuardian());
      const result = await w.service.checkOut(
        KG,
        CHILD,
        STAFF_USER,
        PICKUP_USER,
      );
      // Patch attempt to a brand-new (unapproved) user must fail.
      const ANOTHER_USER = 'aaaaaaaa-3333-3333-3333-aaaaaaaaaaaa';
      await expect(
        w.service.patchEvent(
          KG,
          result.event.id,
          STAFF_USER,
          { pickupUserId: ANOTHER_USER },
          { isAdmin: true },
        ),
      ).rejects.toBeInstanceOf(PickupUserNotAllowedError);
    });
  });

  describe('setDailyStatus', () => {
    it('returns an upserted row and emits notifyDailyStatusChanged', async () => {
      const w = wire();
      const result = await w.service.setDailyStatus(KG, STAFF_USER, {
        childId: CHILD,
        date: '2026-05-01',
        status: 'sick',
        note: 'flu',
      });
      expect(result.status.value).toBe('sick');
      expect(result.note).toBe('flu');
      expect(w.dailyRepo.rows).toHaveLength(1);
      await flushMicrotasks();
      expect(w.notifications.dailyStatusChanges).toHaveLength(1);
      expect(w.notifications.dailyStatusChanges[0].status).toBe('sick');
    });

    it('returns an updated row when called twice on the same (child, date)', async () => {
      const w = wire();
      await w.service.setDailyStatus(KG, STAFF_USER, {
        childId: CHILD,
        date: '2026-05-01',
        status: 'sick',
      });
      await w.service.setDailyStatus(KG, STAFF_USER, {
        childId: CHILD,
        date: '2026-05-01',
        status: 'on_vacation',
        note: 'family trip',
      });
      expect(w.dailyRepo.rows).toHaveLength(1);
      expect(w.dailyRepo.rows[0].status.value).toBe('on_vacation');
      expect(w.dailyRepo.rows[0].note).toBe('family trip');
    });

    it('throws ChildNotFoundError when child does not exist', async () => {
      const w = wire();
      await expect(
        w.service.setDailyStatus(KG, STAFF_USER, {
          childId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
          date: '2026-05-01',
          status: 'sick',
        }),
      ).rejects.toBeInstanceOf(ChildNotFoundError);
    });
  });

  describe('listEventsByChild / listEventsByGroup', () => {
    it('returns events filtered by child', async () => {
      const w = wire();
      await w.service.checkIn(KG, CHILD, STAFF_USER);
      const events = await w.service.listEventsByChild(KG, CHILD);
      expect(events).toHaveLength(1);
    });

    it('returns events for a group', async () => {
      const w = wire();
      await w.service.checkIn(KG, CHILD, STAFF_USER);
      const events = await w.service.listEventsByGroup(KG, 'group-uuid');
      expect(events).toHaveLength(1);
    });
  });

  // ── T7 fix-pass: H1 — kg-wide listEvents (no child / no group filter) ──

  describe('listEvents — kg-wide (T6 H1)', () => {
    it('returns events without crashing when neither childId nor groupId is supplied', async () => {
      const w = wire();
      await w.service.checkIn(KG, CHILD, STAFF_USER);
      const events = await w.service.listEvents(KG, {});
      expect(events).toHaveLength(1);
      expect(events[0].childId).toBe(CHILD);
    });
  });

  // ── T7 fix-pass: M3 — future-dated recordedAt rejection ────────────────

  describe('M3 — assertNotFuture guard', () => {
    it('rejects checkIn with recordedAt > now + 5min skew', async () => {
      const w = wire();
      const futureTime = new Date(NOW.getTime() + 60 * 60 * 1000); // +1h
      await expect(
        w.service.checkIn(KG, CHILD, STAFF_USER, { recordedAt: futureTime }),
      ).rejects.toBeInstanceOf(InvalidAttendanceTimestampError);
    });

    it('rejects checkOut with recordedAt > now + 5min skew', async () => {
      const w = wire();
      w.guardianRepo.put(makeApprovedPickupGuardian());
      const futureTime = new Date(NOW.getTime() + 60 * 60 * 1000);
      await expect(
        w.service.checkOut(KG, CHILD, STAFF_USER, PICKUP_USER, {
          recordedAt: futureTime,
        }),
      ).rejects.toBeInstanceOf(InvalidAttendanceTimestampError);
    });

    it('accepts checkIn with recordedAt within 5min skew tolerance', async () => {
      const w = wire();
      const slightlyAhead = new Date(NOW.getTime() + 2 * 60 * 1000); // +2min
      const result = await w.service.checkIn(KG, CHILD, STAFF_USER, {
        recordedAt: slightlyAhead,
      });
      expect(result.event.recordedAt.getTime()).toBe(slightlyAhead.getTime());
    });

    it('rejects patchEvent when patch.recordedAt is in the future', async () => {
      const w = wire();
      const result = await w.service.checkIn(KG, CHILD, STAFF_USER);
      const futureTime = new Date(NOW.getTime() + 60 * 60 * 1000);
      await expect(
        w.service.patchEvent(
          KG,
          result.event.id,
          STAFF_USER,
          { recordedAt: futureTime },
          { isAdmin: true },
        ),
      ).rejects.toBeInstanceOf(InvalidAttendanceTimestampError);
    });
  });

  // ── T7 fix-pass: H2 — dashboardAttendanceToday respects groupId ────────

  describe('dashboardAttendanceToday — groupId filter (T6 H2)', () => {
    it('returns only the children in the requested group', async () => {
      const w = wire();
      const isoDate = NOW.toLocaleDateString('en-CA', {
        timeZone: 'Asia/Almaty',
      });
      const childA = CHILD;
      const childB = 'cccccccc-bbbb-bbbb-bbbb-cccccccccccc';
      const groupA = 'gggggggg-aaaa-aaaa-aaaa-gggggggggggg';
      const groupB = 'gggggggg-bbbb-bbbb-bbbb-gggggggggggg';
      // Seed both rows + a child→group lookup the fake honours.
      w.dailyRepo.put(
        ChildDailyStatus.createNew(
          {
            id: randomUUID(),
            kindergartenId: KG,
            childId: childA,
            date: isoDate,
            status: ChildIntradayStatus.PRESENT,
            note: null,
            setBy: STAFF_ID,
          },
          w.clock,
        ),
      );
      w.dailyRepo.put(
        ChildDailyStatus.createNew(
          {
            id: randomUUID(),
            kindergartenId: KG,
            childId: childB,
            date: isoDate,
            status: ChildIntradayStatus.PRESENT,
            note: null,
            setBy: STAFF_ID,
          },
          w.clock,
        ),
      );
      w.dailyRepo.childGroup.set(childA, groupA);
      w.dailyRepo.childGroup.set(childB, groupB);

      const onlyA = await w.service.dashboardAttendanceToday(KG, {
        groupId: groupA,
      });
      expect(onlyA).toHaveLength(1);
      expect(onlyA[0].childId).toBe(childA);

      const onlyB = await w.service.dashboardAttendanceToday(KG, {
        groupId: groupB,
      });
      expect(onlyB).toHaveLength(1);
      expect(onlyB[0].childId).toBe(childB);
    });
  });
});
