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
 *   - deleteEvent: soft-deletes (tombstone survives, reads as absent), drops
 *     the paired timeline entry, audits `delete` with a `before` snapshot;
 *     re-deleting → 404.
 *   - daily_status demotion on delete: only check_in of the day + `present` →
 *     `absent`; explicit `sick` / `on_vacation` → untouched; another live
 *     check_in that day → stays `present`.
 *   - patchEvent cascade (admin): childId move re-points the paired timeline
 *     entry and recomputes daily_status for BOTH children; event_type flip
 *     replaces the timeline entry (entry_type is immutable) and clears
 *     pickup_user_id when flipping to check_in; a check_out re-pointed at
 *     another child re-validates the pickup guardian.
 *   - patchEvent admin-gate: non-admin passing childId / eventType → 403
 *     attendance_correction_admin_only.
 *   - patchEvent with an unlinked timeline entry (no source_event_id) → no
 *     cascade, no throw.
 *   - audit: checkIn / checkOut write `create` with an `after` snapshot + actor
 *     ids; setDailyStatus writes `create` on a fresh (child, date) and `update`
 *     when overriding; patchEvent writes `update` with before + after.
 *   - notify:false suppresses the parent notification but still writes event +
 *     timeline + audit.
 *   - isBackdated: undefined → false, today → false, past Almaty day → true.
 *
 * Fake fidelity note: `FakeAttendanceEventRepo` mirrors the relational repo's
 * `deleted_at IS NULL` filter on EVERY read, and derives `listByChild` from the
 * live `child_id` rather than a creation-time index — the demotion and cascade
 * assertions are only meaningful if a tombstoned or re-pointed event actually
 * disappears from the check_in count `recomputeDailyStatus` reads.
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
import { AuditService, RecordAuditInput } from '@/modules/audit/audit.service';
import {
  AuditEntityType,
  AuditLogEntry,
} from '@/modules/audit/domain/entities/audit-log-entry.entity';
import {
  AuditLogRepository,
  ListAuditLogByEntityOptions,
} from '@/modules/audit/infrastructure/persistence/audit-log.repository';
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
import { StaffService } from '@/modules/staff/staff.service';
import { User } from '@/modules/users/domain/entities/user.entity';
import { UserRepository } from '@/modules/users/infrastructure/persistence/user.repository';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { AttendanceService } from './attendance.service';
import { AttendanceEvent } from './domain/entities/attendance-event.entity';
import { ChildDailyStatus } from './domain/entities/child-daily-status.entity';
import { TimelineEntry } from './domain/entities/timeline-entry.entity';
import { AttendanceCorrectionAdminOnlyError } from './domain/errors/attendance-correction-admin-only.error';
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
/** Second child in the same kg — the target of the admin child_id correction. */
const CHILD_B = 'cccccccc-2222-2222-2222-cccccccccccc';
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

/**
 * In-memory stand-in for `AttendanceEventRelationalRepository`.
 *
 * Two fidelity details the demotion / cascade tests depend on:
 *
 *  1. EVERY read filters `deleted_at IS NULL`, exactly as the SQL does (see the
 *     port's docblock). `recomputeDailyStatus` decides whether to demote a day
 *     by counting live check_ins via `listByChild(..., {eventType:'check_in'})`
 *     — a fake that returned tombstones would make the demotion tests pass for
 *     the wrong reason (or never demote at all).
 *
 *  2. `listByChild` filters on the row's CURRENT `child_id` rather than a
 *     creation-time index. An admin correction re-points `child_id` in place,
 *     so an index built at insert would leave the event counted under its old
 *     child and never under the new one — the exact cascade the spec asserts.
 *
 * `from` / `to` / `eventType` / `limit` are honoured too, since the recompute
 * path passes a day window plus `eventType: 'check_in'`.
 */
class FakeAttendanceEventRepo extends AttendanceEventRepository {
  rows = new Map<string, AttendanceEvent>();

  create(kg: string, e: AttendanceEvent): Promise<AttendanceEvent> {
    if (e.kindergartenId !== kg) throw new Error('kg mismatch');
    this.rows.set(e.id, e);
    return Promise.resolve(e);
  }
  findById(kg: string, id: string): Promise<AttendanceEvent | null> {
    const e = this.rows.get(id);
    // Tombstones read as absent — patch/delete of a deleted id must surface
    // attendance_event_not_found rather than mutate it.
    if (!e || e.kindergartenId !== kg || e.deletedAt !== null) {
      return Promise.resolve(null);
    }
    return Promise.resolve(e);
  }
  update(kg: string, e: AttendanceEvent): Promise<AttendanceEvent> {
    if (!this.rows.has(e.id)) throw new Error('row missing');
    if (e.kindergartenId !== kg) throw new Error('kg mismatch');
    this.rows.set(e.id, e);
    return Promise.resolve(e);
  }
  /** Live rows for `kg`, newest first — the shared base of every list read. */
  private live(
    kg: string,
    filter: {
      from?: Date;
      to?: Date;
      eventType?: string;
      limit?: number;
    },
  ): AttendanceEvent[] {
    let items = [...this.rows.values()].filter(
      (e) => e.kindergartenId === kg && e.deletedAt === null,
    );
    if (filter.from !== undefined) {
      items = items.filter((e) => e.recordedAt >= filter.from!);
    }
    if (filter.to !== undefined) {
      items = items.filter((e) => e.recordedAt < filter.to!);
    }
    if (filter.eventType !== undefined) {
      items = items.filter((e) => e.eventType.value === filter.eventType);
    }
    items.sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime());
    return items.slice(
      0,
      filter.limit && filter.limit > 0 ? filter.limit : 100,
    );
  }
  listByChild(
    kg: string,
    childId: string,
    filter: ListAttendanceEventsByChildFilter,
  ): Promise<AttendanceEvent[]> {
    return Promise.resolve(
      this.live(kg, filter).filter((e) => e.childId === childId),
    );
  }
  listByGroup(
    kg: string,
    filter: ListAttendanceEventsByGroupFilter,
  ): Promise<AttendanceEvent[]> {
    // No children table here — the group join is exercised in e2e; the fake
    // only reproduces the kg + live-row scoping.
    return Promise.resolve(this.live(kg, filter));
  }
  listByKindergarten(
    kg: string,
    filter: ListAttendanceEventsByKindergartenFilter,
  ): Promise<AttendanceEvent[]> {
    return Promise.resolve(this.live(kg, filter));
  }
  /** Test-driven buckets + captured args for getDaySummary. */
  lastEventBuckets = { inKindergarten: 0, checkedOut: 0 };
  lastEventArgs: {
    dayStartIso: string;
    dayEndExclusiveIso: string;
    groupId?: string;
  } | null = null;
  override lastEventBucketsForDate(
    _kg: string,
    dayStartIso: string,
    dayEndExclusiveIso: string,
    groupId?: string,
  ): Promise<{ inKindergarten: number; checkedOut: number }> {
    this.lastEventArgs = { dayStartIso, dayEndExclusiveIso, groupId };
    return Promise.resolve(this.lastEventBuckets);
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
  /** Test-driven histogram + captured args for getDaySummary. */
  statusCounts: Record<string, number> = {};
  statusCountArgs: {
    date: string;
    dayStartIso: string;
    dayEndExclusiveIso: string;
    groupId?: string;
  } | null = null;
  override countByStatusForDate(
    _kg: string,
    date: string,
    dayStartIso: string,
    dayEndExclusiveIso: string,
    groupId?: string,
  ): Promise<Record<string, number>> {
    this.statusCountArgs = { date, dayStartIso, dayEndExclusiveIso, groupId };
    return Promise.resolve(this.statusCounts);
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
  /**
   * Backs the event↔entry link off the same in-memory map, matching on
   * `sourceEventId`. Entries written before the column existed (or which the
   * migration backfill could not match) carry null and resolve to null here —
   * the cascade treats that as "nothing to cascade".
   */
  findBySourceEventId(
    kg: string,
    sourceEventId: string,
  ): Promise<TimelineEntry | null> {
    const t =
      [...this.rows.values()].find(
        (e) => e.kindergartenId === kg && e.sourceEventId === sourceEventId,
      ) ?? null;
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
  findFullNamesByIds(kg: string, ids: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const id of [...new Set(ids)]) {
      const c = this.byId.get(id);
      if (c && c.kindergartenId === kg) out.set(id, c.toState().fullName);
    }
    return Promise.resolve(out);
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

/** In-memory `audit_log`, tenant-scoped, newest-first — as the SQL orders it. */
class FakeAuditLogRepo extends AuditLogRepository {
  rows: AuditLogEntry[] = [];
  create(kg: string, entry: AuditLogEntry): Promise<AuditLogEntry> {
    if (entry.kindergartenId !== kg) throw new Error('kg mismatch');
    this.rows.push(entry);
    return Promise.resolve(entry);
  }
  listByEntity(
    kg: string,
    entityType: AuditEntityType,
    entityId: string,
    opts: ListAuditLogByEntityOptions,
  ): Promise<AuditLogEntry[]> {
    const matched = this.rows
      .filter(
        (r) =>
          r.kindergartenId === kg &&
          r.entityType === entityType &&
          r.entityId === entityId,
      )
      .reverse();
    const offset = opts.offset ?? 0;
    return Promise.resolve(
      matched.slice(offset, offset + (opts.limit ?? matched.length)),
    );
  }
}

/**
 * Real AuditService over an in-memory audit_log, with every `record(...)`
 * argument captured so tests can assert on the trail the mutation left. The
 * production wiring is deliberately non-optional (an unwired audit port must
 * fail at boot, not drop the trail silently), so this is a real subclass rather
 * than a stub — the entry is genuinely built and persisted.
 */
class FakeAuditService extends AuditService {
  calls: RecordAuditInput[] = [];
  constructor(clock: ClockPort) {
    super(new FakeAuditLogRepo(), clock);
  }
  override record(input: RecordAuditInput): Promise<AuditLogEntry> {
    this.calls.push(input);
    return super.record(input);
  }
  /** Every captured call for one action — the usual assertion entry point. */
  callsFor(action: 'create' | 'update' | 'delete'): RecordAuditInput[] {
    return this.calls.filter((c) => c.action === action);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

function makeChild(id: string = CHILD, fullName = 'Test Child'): Child {
  return Child.hydrate({
    id,
    kindergartenId: KG,
    iin: null,
    fullName,
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
    /** Approval is per-child — re-pointing a check_out re-checks this pair. */
    childId?: string;
  } = {},
): ChildGuardian {
  return ChildGuardian.hydrate({
    id: randomUUID(),
    kindergartenId: KG,
    childId: overrides.childId ?? CHILD,
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
  audit: FakeAuditService;
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
  const audit = new FakeAuditService(clock);
  childRepo.put(makeChild());
  childRepo.put(makeChild(CHILD_B, 'Test Child B'));
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
    audit,
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
    audit,
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
        { skipEditWindow: true, allowStructuralCorrection: true },
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
          { skipEditWindow: false, allowStructuralCorrection: false },
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
        { skipEditWindow: false, allowStructuralCorrection: false },
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
          { skipEditWindow: true, allowStructuralCorrection: true },
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
          { skipEditWindow: true, allowStructuralCorrection: true },
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
          { skipEditWindow: true, allowStructuralCorrection: true },
        ),
      ).rejects.toBeInstanceOf(PickupUserNotAllowedError);
    });
  });

  // ── Admin corrections: child_id / event_type + their cascade ────────────

  describe('patchEvent — admin-only gate', () => {
    it('throws AttendanceCorrectionAdminOnlyError when a non-admin patches childId', async () => {
      const w = wire();
      const r = await w.service.checkIn(KG, CHILD, STAFF_USER);
      await expect(
        w.service.patchEvent(
          KG,
          r.event.id,
          STAFF_USER,
          { childId: CHILD_B },
          { skipEditWindow: false, allowStructuralCorrection: false },
        ),
      ).rejects.toBeInstanceOf(AttendanceCorrectionAdminOnlyError);
      // The row is untouched — the gate fires before any mutation.
      expect(w.eventRepo.rows.get(r.event.id)!.childId).toBe(CHILD);
    });

    it('throws AttendanceCorrectionAdminOnlyError when a non-admin patches eventType', async () => {
      const w = wire();
      const r = await w.service.checkIn(KG, CHILD, STAFF_USER);
      await expect(
        w.service.patchEvent(
          KG,
          r.event.id,
          STAFF_USER,
          { eventType: 'check_out' },
          { skipEditWindow: false, allowStructuralCorrection: false },
        ),
      ).rejects.toBeInstanceOf(AttendanceCorrectionAdminOnlyError);
      expect(w.eventRepo.rows.get(r.event.id)!.eventType.value).toBe(
        'check_in',
      );
    });

    // The reception-on-the-admin-route case: the two grants are independent,
    // so skipping the edit window must NOT drag the structural corrections
    // along with it. Collapsing these back into one `isAdmin` flag would hand
    // reception the power to re-point events onto other children.
    it('throws AttendanceCorrectionAdminOnlyError when the caller may skip the edit window but not correct structure', async () => {
      const w = wire();
      const r = await w.service.checkIn(KG, CHILD, STAFF_USER);
      await expect(
        w.service.patchEvent(
          KG,
          r.event.id,
          STAFF_USER,
          { childId: CHILD_B },
          { skipEditWindow: true, allowStructuralCorrection: false },
        ),
      ).rejects.toBeInstanceOf(AttendanceCorrectionAdminOnlyError);
      expect(w.eventRepo.rows.get(r.event.id)!.childId).toBe(CHILD);
    });

    it('returns the patched event when the caller may skip the edit window but only touches ordinary fields', async () => {
      const w = wire();
      const r = await w.service.checkIn(KG, CHILD, STAFF_USER);
      w.clock.set(new Date('2026-05-03T09:00:00.000Z')); // two days later
      const updated = await w.service.patchEvent(
        KG,
        r.event.id,
        STAFF_USER,
        { notes: 'reception fixing an earlier day' },
        { skipEditWindow: true, allowStructuralCorrection: false },
      );
      expect(updated.notes).toBe('reception fixing an earlier day');
    });
  });

  describe('patchEvent — childId cascade', () => {
    it('moves the paired timeline entry to the new child and recomputes daily_status for both', async () => {
      const w = wire();
      const r = await w.service.checkIn(KG, CHILD, STAFF_USER);
      expect(w.dailyRepo.rows).toHaveLength(1);
      expect(w.dailyRepo.rows[0].status.value).toBe('present');

      const patched = await w.service.patchEvent(
        KG,
        r.event.id,
        STAFF_USER,
        { childId: CHILD_B },
        { skipEditWindow: true, allowStructuralCorrection: true },
      );

      expect(patched.childId).toBe(CHILD_B);
      // The timeline entry found via source_event_id followed the event.
      const entry = w.timelineRepo.rows.get(r.timelineEntry.id);
      expect(entry).toBeDefined();
      expect(entry!.childId).toBe(CHILD_B);
      // Old child lost its only check_in → demoted; new child gained one →
      // promoted. Both buckets recomputed off one patch.
      const oldRow = w.dailyRepo.rows.find((x) => x.childId === CHILD);
      const newRow = w.dailyRepo.rows.find((x) => x.childId === CHILD_B);
      expect(oldRow!.status.value).toBe('absent');
      expect(newRow!.status.value).toBe('present');
    });

    it('records an update audit entry carrying the child_id move in before/after', async () => {
      const w = wire();
      const r = await w.service.checkIn(KG, CHILD, STAFF_USER);
      await w.service.patchEvent(
        KG,
        r.event.id,
        STAFF_USER,
        { childId: CHILD_B },
        { skipEditWindow: true, allowStructuralCorrection: true },
      );
      const updates = w.audit.callsFor('update');
      expect(updates).toHaveLength(1);
      expect(updates[0].entityType).toBe('attendance_event');
      expect(updates[0].entityId).toBe(r.event.id);
      expect(updates[0].actorUserId).toBe(STAFF_USER);
      expect(updates[0].actorStaffId).toBe(STAFF_ID);
      expect(updates[0].before).toMatchObject({ childId: CHILD });
      expect(updates[0].after).toMatchObject({ childId: CHILD_B });
    });

    it('throws PickupUserNotAllowedError when a check_out is re-pointed at a child the pickup user cannot collect', async () => {
      const w = wire();
      // Approved for CHILD only — CHILD_B has no guardian row.
      w.guardianRepo.put(makeApprovedPickupGuardian());
      const r = await w.service.checkOut(KG, CHILD, STAFF_USER, PICKUP_USER);
      await expect(
        w.service.patchEvent(
          KG,
          r.event.id,
          STAFF_USER,
          { childId: CHILD_B },
          { skipEditWindow: true, allowStructuralCorrection: true },
        ),
      ).rejects.toBeInstanceOf(PickupUserNotAllowedError);
      // Nothing moved — the re-validation fires before the write.
      expect(w.eventRepo.rows.get(r.event.id)!.childId).toBe(CHILD);
    });

    it('returns the patched event when the pickup user is also approved for the new child', async () => {
      const w = wire();
      w.guardianRepo.put(makeApprovedPickupGuardian());
      w.guardianRepo.put(makeApprovedPickupGuardian({ childId: CHILD_B }));
      const r = await w.service.checkOut(KG, CHILD, STAFF_USER, PICKUP_USER);
      const patched = await w.service.patchEvent(
        KG,
        r.event.id,
        STAFF_USER,
        { childId: CHILD_B },
        { skipEditWindow: true, allowStructuralCorrection: true },
      );
      expect(patched.childId).toBe(CHILD_B);
      expect(patched.pickupUserId).toBe(PICKUP_USER);
    });

    it('returns the patched event without cascading when no timeline entry links to it', async () => {
      const w = wire();
      const r = await w.service.checkIn(KG, CHILD, STAFF_USER);
      // Rewrite the paired entry as an unlinked one — mirrors a pre-
      // source_event_id row the migration backfill could not match.
      const unlinked = TimelineEntry.hydrate({
        ...r.timelineEntry.toState(),
        sourceEventId: null,
      });
      w.timelineRepo.rows.set(unlinked.id, unlinked);

      const patched = await w.service.patchEvent(
        KG,
        r.event.id,
        STAFF_USER,
        { childId: CHILD_B },
        { skipEditWindow: true, allowStructuralCorrection: true },
      );

      // The correction itself still lands...
      expect(patched.childId).toBe(CHILD_B);
      // ...but the unmatched entry is left alone rather than the patch failing.
      expect(w.timelineRepo.rows.get(unlinked.id)!.childId).toBe(CHILD);
      expect(w.timelineRepo.rows.size).toBe(1);
    });
  });

  describe('patchEvent — eventType cascade', () => {
    it('replaces the timeline entry with a check_out entry when the event type is flipped', async () => {
      const w = wire();
      const r = await w.service.checkIn(KG, CHILD, STAFF_USER);
      const oldEntryId = r.timelineEntry.id;

      const patched = await w.service.patchEvent(
        KG,
        r.event.id,
        STAFF_USER,
        { eventType: 'check_out' },
        { skipEditWindow: true, allowStructuralCorrection: true },
      );

      expect(patched.eventType.value).toBe('check_out');
      // entry_type is immutable by design → replace, not mutate.
      expect(w.timelineRepo.rows.has(oldEntryId)).toBe(false);
      const entries = [...w.timelineRepo.rows.values()];
      expect(entries).toHaveLength(1);
      expect(entries[0].id).not.toBe(oldEntryId);
      expect(entries[0].entryType.value).toBe('check_out');
      // The fresh entry stays linked to the same event.
      expect(entries[0].sourceEventId).toBe(r.event.id);
      expect(entries[0].childId).toBe(CHILD);
    });

    it('demotes the day to absent when the only check_in is flipped to check_out', async () => {
      const w = wire();
      const r = await w.service.checkIn(KG, CHILD, STAFF_USER);
      expect(w.dailyRepo.rows[0].status.value).toBe('present');
      await w.service.patchEvent(
        KG,
        r.event.id,
        STAFF_USER,
        { eventType: 'check_out' },
        { skipEditWindow: true, allowStructuralCorrection: true },
      );
      // No live check_in left for the day → the inferred present falls back.
      expect(w.dailyRepo.rows[0].status.value).toBe('absent');
    });

    it('clears pickup_user_id when the event type is flipped to check_in', async () => {
      const w = wire();
      w.guardianRepo.put(makeApprovedPickupGuardian());
      const r = await w.service.checkOut(KG, CHILD, STAFF_USER, PICKUP_USER);
      expect(r.event.pickupUserId).toBe(PICKUP_USER);

      const patched = await w.service.patchEvent(
        KG,
        r.event.id,
        STAFF_USER,
        { eventType: 'check_in' },
        { skipEditWindow: true, allowStructuralCorrection: true },
      );

      // A check_in can never carry a pickup user — the entity clears it.
      expect(patched.eventType.value).toBe('check_in');
      expect(patched.pickupUserId).toBeNull();
      // The replacement timeline entry is a check_in too.
      const entries = [...w.timelineRepo.rows.values()];
      expect(entries).toHaveLength(1);
      expect(entries[0].entryType.value).toBe('check_in');
    });
  });

  // ── deleteEvent ────────────────────────────────────────────────────────

  describe('deleteEvent', () => {
    it('soft-deletes the event, drops the paired timeline entry and audits the delete', async () => {
      const w = wire();
      const r = await w.service.checkIn(KG, CHILD, STAFF_USER);

      await w.service.deleteEvent(KG, r.event.id, STAFF_USER);

      // The row survives as a tombstone so audit_log.entity_id keeps resolving…
      expect(w.eventRepo.rows.has(r.event.id)).toBe(true);
      expect(w.eventRepo.rows.get(r.event.id)!.deletedAt).toEqual(NOW);
      // …but every read path treats it as absent.
      await expect(
        w.service.getEventById(KG, r.event.id),
      ).rejects.toBeInstanceOf(AttendanceEventNotFoundError);
      expect(await w.service.listEventsByChild(KG, CHILD)).toHaveLength(0);
      // The timeline entry mirrors the event, so it goes with it.
      expect(w.timelineRepo.rows.size).toBe(0);

      const deletes = w.audit.callsFor('delete');
      expect(deletes).toHaveLength(1);
      expect(deletes[0].entityType).toBe('attendance_event');
      expect(deletes[0].entityId).toBe(r.event.id);
      expect(deletes[0].actorUserId).toBe(STAFF_USER);
      expect(deletes[0].actorStaffId).toBe(STAFF_ID);
      // `before` is the pre-delete snapshot — still live at capture time.
      expect(deletes[0].before).toMatchObject({
        id: r.event.id,
        childId: CHILD,
        eventType: 'check_in',
        deletedAt: null,
      });
    });

    it('throws AttendanceEventNotFoundError when the event is already deleted', async () => {
      const w = wire();
      const r = await w.service.checkIn(KG, CHILD, STAFF_USER);
      await w.service.deleteEvent(KG, r.event.id, STAFF_USER);
      await expect(
        w.service.deleteEvent(KG, r.event.id, STAFF_USER),
      ).rejects.toBeInstanceOf(AttendanceEventNotFoundError);
      // Still exactly one delete entry — the tombstone timestamp is not moved.
      expect(w.audit.callsFor('delete')).toHaveLength(1);
    });

    it('throws AttendanceEventNotFoundError when the event does not exist', async () => {
      const w = wire();
      await expect(
        w.service.deleteEvent(
          KG,
          'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
          STAFF_USER,
        ),
      ).rejects.toBeInstanceOf(AttendanceEventNotFoundError);
    });
  });

  // ── daily_status demotion on delete ────────────────────────────────────
  //
  // The rule is deliberately narrow: `present → absent` ONLY when no live
  // check_in remains for the day. Explicit operator decisions outrank anything
  // inferred from the event log.

  describe('deleteEvent — daily_status demotion', () => {
    /** Almaty civil day for NOW (2026-05-01T09:00Z = 14:00 Almaty). */
    const TODAY = '2026-05-01';

    function seedStatus(
      w: Wired,
      status: ChildIntradayStatus,
      note: string | null = null,
    ): void {
      w.dailyRepo.put(
        ChildDailyStatus.createNew(
          {
            id: randomUUID(),
            kindergartenId: KG,
            childId: CHILD,
            date: TODAY,
            status,
            note,
            setBy: STAFF_ID,
          },
          w.clock,
        ),
      );
    }

    it('demotes present to absent when the only check_in of the day is deleted', async () => {
      const w = wire();
      const r = await w.service.checkIn(KG, CHILD, STAFF_USER);
      expect(w.dailyRepo.rows[0].status.value).toBe('present');

      await w.service.deleteEvent(KG, r.event.id, STAFF_USER);

      expect(w.dailyRepo.rows).toHaveLength(1);
      expect(w.dailyRepo.rows[0].status.value).toBe('absent');
    });

    it('preserves an explicit sick status when a check_in of that day is deleted', async () => {
      const w = wire();
      seedStatus(w, ChildIntradayStatus.SICK, 'parent reported flu');
      // check_in does not promote `sick`, so the row is still sick here.
      const r = await w.service.checkIn(KG, CHILD, STAFF_USER);
      expect(w.dailyRepo.rows[0].status.value).toBe('sick');

      await w.service.deleteEvent(KG, r.event.id, STAFF_USER);

      // An operator's explicit call outranks the event log — untouched.
      expect(w.dailyRepo.rows[0].status.value).toBe('sick');
      expect(w.dailyRepo.rows[0].note).toBe('parent reported flu');
    });

    it('preserves an explicit on_vacation status when a check_in of that day is deleted', async () => {
      const w = wire();
      seedStatus(w, ChildIntradayStatus.ON_VACATION);
      const r = await w.service.checkIn(KG, CHILD, STAFF_USER);

      await w.service.deleteEvent(KG, r.event.id, STAFF_USER);

      expect(w.dailyRepo.rows[0].status.value).toBe('on_vacation');
    });

    it('keeps the day present when another live check_in remains', async () => {
      const w = wire();
      // Two check-ins on the same Almaty day, both in the past.
      const first = await w.service.checkIn(KG, CHILD, STAFF_USER, {
        recordedAt: new Date('2026-05-01T03:00:00.000Z'),
      });
      await w.service.checkIn(KG, CHILD, STAFF_USER, {
        recordedAt: new Date('2026-05-01T04:00:00.000Z'),
      });
      expect(w.dailyRepo.rows[0].status.value).toBe('present');

      await w.service.deleteEvent(KG, first.event.id, STAFF_USER);

      // The surviving check_in still justifies `present`.
      expect(w.dailyRepo.rows[0].status.value).toBe('present');
      expect(w.eventRepo.rows.size).toBe(2);
      expect(await w.service.listEventsByChild(KG, CHILD)).toHaveLength(1);
    });
  });

  // ── Audit trail + notify opt ───────────────────────────────────────────

  describe('audit trail', () => {
    it('records a create entry with an after snapshot and the actor ids on checkIn', async () => {
      const w = wire();
      const r = await w.service.checkIn(KG, CHILD, STAFF_USER);

      expect(w.audit.calls).toHaveLength(1);
      const [entry] = w.audit.callsFor('create');
      expect(entry.entityType).toBe('attendance_event');
      expect(entry.entityId).toBe(r.event.id);
      expect(entry.actorUserId).toBe(STAFF_USER);
      expect(entry.actorStaffId).toBe(STAFF_ID);
      expect(entry.after).toMatchObject({
        id: r.event.id,
        childId: CHILD,
        eventType: 'check_in',
        method: 'manual',
      });
      // Nothing existed before a create.
      expect(entry.before).toBeUndefined();
    });

    it('records a create entry with an after snapshot on checkOut', async () => {
      const w = wire();
      w.guardianRepo.put(makeApprovedPickupGuardian());
      const r = await w.service.checkOut(KG, CHILD, STAFF_USER, PICKUP_USER);

      expect(w.audit.calls).toHaveLength(1);
      const [entry] = w.audit.callsFor('create');
      expect(entry.entityId).toBe(r.event.id);
      expect(entry.actorUserId).toBe(STAFF_USER);
      expect(entry.actorStaffId).toBe(STAFF_ID);
      expect(entry.after).toMatchObject({
        eventType: 'check_out',
        pickupUserId: PICKUP_USER,
      });
    });

    it('records no audit entry when the write is rejected before it happens', async () => {
      const w = wire();
      // No guardian seeded → pickup validation throws before any row is written.
      await expect(
        w.service.checkOut(KG, CHILD, STAFF_USER, PICKUP_USER),
      ).rejects.toBeInstanceOf(PickupUserNotAllowedError);
      expect(w.audit.calls).toHaveLength(0);
    });

    it('records create on a fresh (child, date) and update when setDailyStatus overrides', async () => {
      const w = wire();
      await w.service.setDailyStatus(KG, STAFF_USER, {
        childId: CHILD,
        date: '2026-05-01',
        status: 'sick',
      });

      expect(w.audit.calls).toHaveLength(1);
      expect(w.audit.calls[0].action).toBe('create');
      expect(w.audit.calls[0].entityType).toBe('child_daily_status');
      expect(w.audit.calls[0].before).toBeNull();
      expect(w.audit.calls[0].after).toMatchObject({ status: 'sick' });

      await w.service.setDailyStatus(KG, STAFF_USER, {
        childId: CHILD,
        date: '2026-05-01',
        status: 'on_vacation',
        note: 'family trip',
      });

      expect(w.audit.calls).toHaveLength(2);
      expect(w.audit.calls[1].action).toBe('update');
      expect(w.audit.calls[1].before).toMatchObject({ status: 'sick' });
      expect(w.audit.calls[1].after).toMatchObject({
        status: 'on_vacation',
        note: 'family trip',
      });
    });
  });

  describe('notify opt', () => {
    it('suppresses the check-in notification but still writes event, timeline and audit', async () => {
      const w = wire();
      const r = await w.service.checkIn(KG, CHILD, STAFF_USER, {
        notify: false,
      });

      // The admin back-fill must not tell parents their child just arrived.
      expect(w.notifications.checkIns).toHaveLength(0);
      expect(w.notifications.timelines).toHaveLength(0);
      // Everything else is written exactly as usual.
      expect(w.eventRepo.rows.size).toBe(1);
      expect(w.timelineRepo.rows.size).toBe(1);
      expect(w.dailyRepo.rows).toHaveLength(1);
      expect(w.audit.callsFor('create')).toHaveLength(1);
      expect(w.audit.callsFor('create')[0].entityId).toBe(r.event.id);
    });

    it('suppresses the check-out notification but still writes event, timeline and audit', async () => {
      const w = wire();
      w.guardianRepo.put(makeApprovedPickupGuardian());
      await w.service.checkOut(KG, CHILD, STAFF_USER, PICKUP_USER, {
        notify: false,
      });

      expect(w.notifications.checkOuts).toHaveLength(0);
      expect(w.notifications.timelines).toHaveLength(0);
      expect(w.eventRepo.rows.size).toBe(1);
      expect(w.timelineRepo.rows.size).toBe(1);
      expect(w.audit.callsFor('create')).toHaveLength(1);
    });

    it('notifies by default when notify is omitted', async () => {
      const w = wire();
      await w.service.checkIn(KG, CHILD, STAFF_USER);
      expect(w.notifications.checkIns).toHaveLength(1);
      expect(w.notifications.timelines).toHaveLength(1);
    });
  });

  // ── isBackdated ────────────────────────────────────────────────────────

  describe('isBackdated', () => {
    // NOW = 2026-05-01T09:00:00Z = 14:00 Almaty (UTC+5) → today is 2026-05-01,
    // whose instant window is [2026-04-30T19:00Z, 2026-05-01T19:00Z).
    it('returns false for undefined (a live write is never backdated)', () => {
      const w = wire();
      expect(w.service.isBackdated(undefined)).toBe(false);
    });

    it('returns false for a timestamp on today in Asia/Almaty', () => {
      const w = wire();
      // 2026-05-01T00:00Z = 05:00 Almaty on 2026-05-01 — same civil day as NOW.
      expect(w.service.isBackdated(new Date('2026-05-01T00:00:00.000Z'))).toBe(
        false,
      );
    });

    it('returns true for a timestamp on a past Asia/Almaty day', () => {
      const w = wire();
      expect(w.service.isBackdated(new Date('2026-04-30T09:00:00.000Z'))).toBe(
        true,
      );
    });

    it('returns true just before the Almaty day boundary (UTC would disagree)', () => {
      const w = wire();
      // 2026-04-30T18:59Z = 23:59 Almaty on 2026-04-30 — yesterday locally,
      // even though UTC still calls it the 30th's evening.
      expect(w.service.isBackdated(new Date('2026-04-30T18:59:00.000Z'))).toBe(
        true,
      );
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

  describe('getDaySummary', () => {
    it('returns all six buckets including late, mapped from event + daily-status ports', async () => {
      const w = wire();
      w.eventRepo.lastEventBuckets = { inKindergarten: 42, checkedOut: 7 };
      w.dailyRepo.statusCounts = {
        present: 40,
        absent: 5,
        on_vacation: 3,
        sick: 2,
        late: 4,
      };

      const res = await w.service.getDaySummary(KG, {});

      expect(res).toEqual({
        in_kindergarten: 42,
        checked_out: 7,
        absent: 5,
        on_vacation: 3,
        sick: 2,
        late: 4,
      });
    });

    it('returns zeros (incl. late) when no events and no daily-status rows exist', async () => {
      const w = wire();
      const res = await w.service.getDaySummary(KG, {});
      expect(res).toEqual({
        in_kindergarten: 0,
        checked_out: 0,
        absent: 0,
        on_vacation: 0,
        sick: 0,
        late: 0,
      });
    });

    it('defaults the date to Asia/Almaty today and derives the day instant window', async () => {
      // NOW = 2026-05-01T09:00:00Z = 14:00 Almaty (UTC+5) → today 2026-05-01.
      const w = wire();
      await w.service.getDaySummary(KG, {});
      // Almaty 2026-05-01 00:00 = UTC 2026-04-30T19:00:00Z.
      // Almaty 2026-05-02 00:00 = UTC 2026-05-01T19:00:00Z.
      expect(w.dailyRepo.statusCountArgs).toEqual({
        date: '2026-05-01',
        dayStartIso: '2026-04-30T19:00:00.000Z',
        dayEndExclusiveIso: '2026-05-01T19:00:00.000Z',
        groupId: undefined,
      });
      expect(w.eventRepo.lastEventArgs).toEqual({
        dayStartIso: '2026-04-30T19:00:00.000Z',
        dayEndExclusiveIso: '2026-05-01T19:00:00.000Z',
        groupId: undefined,
      });
    });

    it('honours an explicit date override and propagates the group filter', async () => {
      const w = wire();
      const groupId = 'a1b2c3d4-0000-0000-0000-000000000001';
      await w.service.getDaySummary(KG, { date: '2026-04-10', groupId });
      expect(w.dailyRepo.statusCountArgs).toEqual({
        date: '2026-04-10',
        dayStartIso: '2026-04-09T19:00:00.000Z',
        dayEndExclusiveIso: '2026-04-10T19:00:00.000Z',
        groupId,
      });
      expect(w.eventRepo.lastEventArgs).toEqual({
        dayStartIso: '2026-04-09T19:00:00.000Z',
        dayEndExclusiveIso: '2026-04-10T19:00:00.000Z',
        groupId,
      });
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
          { skipEditWindow: true, allowStructuralCorrection: true },
        ),
      ).rejects.toBeInstanceOf(InvalidAttendanceTimestampError);
    });
  });

  // ── Identity overlays ──────────────────────────────────────────────────────

  describe('resolvePickupUserNames', () => {
    function makeCheckOutEvent(pickupUserId: string | null): AttendanceEvent {
      return AttendanceEvent.createCheckOut(
        {
          id: randomUUID(),
          kindergartenId: KG,
          childId: CHILD,
          method: AttendanceMethod.MANUAL,
          recordedBy: STAFF_ID,
          pickupUserId,
          notes: null,
          recordedAt: NOW,
        },
        { now: () => NOW },
      );
    }
    function makeUser(id: string, fullName: string): User {
      return User.hydrate({
        id,
        phone: '+77770000000',
        fullName,
        avatarUrl: null,
        iin: null,
        dateOfBirth: null,
        locale: 'ru',
      });
    }
    class FakeUserRepo {
      rows = new Map<string, User>();
      put(u: User): void {
        this.rows.set(u.id, u);
      }
      findById(id: string): Promise<User | null> {
        return Promise.resolve(this.rows.get(id) ?? null);
      }
    }

    function wireWithUsers(userRepo: FakeUserRepo): AttendanceService {
      const clock = new FixedClock(NOW);
      return new AttendanceService(
        new FakeAttendanceEventRepo(),
        new FakeChildDailyStatusRepo(),
        new FakeTimelineRepo(),
        new FakeChildRepo(),
        new FakeGuardianRepo(),
        new FakeStaffRepo(),
        clock,
        new FakeNotificationPort(),
        new FakeAuditService(clock),
        userRepo as unknown as UserRepository,
      );
    }

    it('resolves pickup_user_full_name from users.full_name (deduped)', async () => {
      const userRepo = new FakeUserRepo();
      userRepo.put(makeUser(PICKUP_USER, 'Бахыт Нурланова'));
      const service = wireWithUsers(userRepo);
      // Two check-out events for the same pickup user → single lookup.
      const map = await service.resolvePickupUserNames([
        makeCheckOutEvent(PICKUP_USER),
        makeCheckOutEvent(PICKUP_USER),
      ]);
      expect(map.size).toBe(1);
      expect(map.get(PICKUP_USER)).toBe('Бахыт Нурланова');
    });

    it('returns null when the user row is missing', async () => {
      const service = wireWithUsers(new FakeUserRepo());
      const map = await service.resolvePickupUserNames([
        makeCheckOutEvent(PICKUP_USER),
      ]);
      expect(map.get(PICKUP_USER)).toBeNull();
    });

    it('collapses a blank/whitespace-only user name to null', async () => {
      const userRepo = new FakeUserRepo();
      userRepo.put(makeUser(PICKUP_USER, '   '));
      const service = wireWithUsers(userRepo);
      const map = await service.resolvePickupUserNames([
        makeCheckOutEvent(PICKUP_USER),
      ]);
      expect(map.get(PICKUP_USER)).toBeNull();
    });

    it('skips events with a null pickupUserId (check-in rows)', async () => {
      const service = wireWithUsers(new FakeUserRepo());
      const map = await service.resolvePickupUserNames([
        makeCheckOutEvent(null),
      ]);
      expect(map.size).toBe(0);
    });

    it('fails closed with an empty map when the users port is not wired', async () => {
      const w = wire();
      const map = await w.service.resolvePickupUserNames([
        makeCheckOutEvent(PICKUP_USER),
      ]);
      expect(map.size).toBe(0);
    });
  });

  describe('resolveChildNames', () => {
    it('resolves child_id → full_name via the child repo (deduped)', async () => {
      const w = wire(); // seeds CHILD → 'Test Child'
      const map = await w.service.resolveChildNames(KG, [
        { childId: CHILD },
        { childId: CHILD },
      ]);
      expect(map.get(CHILD)).toBe('Test Child');
      expect(map.size).toBe(1);
    });

    it('omits ids with no matching child row (rendered as null upstream)', async () => {
      const w = wire();
      const map = await w.service.resolveChildNames(KG, [
        { childId: 'dddddddd-dddd-dddd-dddd-dddddddddddd' },
      ]);
      expect(map.size).toBe(0);
    });
  });

  describe('resolveRecordedByNames / resolveSetByNames', () => {
    // Thin stand-in for StaffService.resolveIdentity — the real staff/users
    // fallback is exercised in staff.service.spec; here we only assert the
    // batching / fail-closed orchestration.
    class FakeStaffService {
      resolveIdentity(
        member: StaffMember,
      ): Promise<{ fullName: string | null; phone: string | null }> {
        const s = member.toState();
        return Promise.resolve({ fullName: s.fullName, phone: s.phone });
      }
    }
    class FakeStaffByIdRepo extends FakeStaffRepo {
      byId = new Map<string, StaffMember>();
      putById(s: StaffMember): void {
        this.byId.set(`${s.kindergartenId}|${s.id}`, s);
      }
      override findById(kg: string, id: string): Promise<StaffMember | null> {
        return Promise.resolve(this.byId.get(`${kg}|${id}`) ?? null);
      }
    }
    function makeStaffMember(id: string, fullName: string | null): StaffMember {
      return StaffMember.hydrate({
        id,
        kindergartenId: KG,
        userId: randomUUID(),
        fullName,
        phone: null,
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
    function wireWithStaff(staffRepo: FakeStaffByIdRepo): AttendanceService {
      const clock = new FixedClock(NOW);
      return new AttendanceService(
        new FakeAttendanceEventRepo(),
        new FakeChildDailyStatusRepo(),
        new FakeTimelineRepo(),
        new FakeChildRepo(),
        new FakeGuardianRepo(),
        staffRepo,
        clock,
        new FakeNotificationPort(),
        new FakeAuditService(clock),
        undefined,
        new FakeStaffService() as unknown as StaffService,
      );
    }

    it('resolveRecordedByNames resolves the staff display name (deduped)', async () => {
      const staffRepo = new FakeStaffByIdRepo();
      staffRepo.putById(makeStaffMember(STAFF_ID, 'Айгуль Сатпаева'));
      const service = wireWithStaff(staffRepo);
      const map = await service.resolveRecordedByNames(KG, [
        { recordedBy: STAFF_ID },
        { recordedBy: STAFF_ID },
      ]);
      expect(map.size).toBe(1);
      expect(map.get(STAFF_ID)).toBe('Айгуль Сатпаева');
    });

    it('resolveSetByNames resolves the staff display name', async () => {
      const staffRepo = new FakeStaffByIdRepo();
      staffRepo.putById(makeStaffMember(STAFF_ID, 'Айгуль Сатпаева'));
      const service = wireWithStaff(staffRepo);
      const map = await service.resolveSetByNames(KG, [{ setBy: STAFF_ID }]);
      expect(map.get(STAFF_ID)).toBe('Айгуль Сатпаева');
    });

    it('returns null when the staff row is missing', async () => {
      const service = wireWithStaff(new FakeStaffByIdRepo());
      const map = await service.resolveRecordedByNames(KG, [
        { recordedBy: STAFF_ID },
      ]);
      expect(map.get(STAFF_ID)).toBeNull();
    });

    it('collapses a blank/whitespace-only staff name to null', async () => {
      const staffRepo = new FakeStaffByIdRepo();
      staffRepo.putById(makeStaffMember(STAFF_ID, '   '));
      const service = wireWithStaff(staffRepo);
      const map = await service.resolveRecordedByNames(KG, [
        { recordedBy: STAFF_ID },
      ]);
      expect(map.get(STAFF_ID)).toBeNull();
    });

    it('skips rows with a null source id', async () => {
      const service = wireWithStaff(new FakeStaffByIdRepo());
      const map = await service.resolveRecordedByNames(KG, [
        { recordedBy: null },
      ]);
      expect(map.size).toBe(0);
    });

    it('fails closed with an empty map when the staff service is not wired', async () => {
      const w = wire();
      const map = await w.service.resolveRecordedByNames(KG, [
        { recordedBy: STAFF_ID },
      ]);
      expect(map.size).toBe(0);
    });
  });
});
