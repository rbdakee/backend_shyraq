import { Inject, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { NotificationPort } from '@/common/notifications/notification.port';
import { ChildNotFoundError } from '@/modules/child/domain/errors/child-not-found.error';
import { ChildGuardianRepository } from '@/modules/child/infrastructure/persistence/child-guardian.repository';
import { ChildRepository } from '@/modules/child/infrastructure/persistence/child.repository';
import { StaffNotFoundError } from '@/modules/staff/domain/errors/staff-not-found.error';
import { StaffMemberRepository } from '@/modules/staff/infrastructure/persistence/staff-member.repository';
import { StaffService } from '@/modules/staff/staff.service';
import { UserRepository } from '@/modules/users/infrastructure/persistence/user.repository';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
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
import { TimelineEntryType } from './domain/value-objects/timeline-entry-type.vo';
import {
  AttendanceEventRepository,
  ListAttendanceEventsByChildFilter,
  ListAttendanceEventsByGroupFilter,
} from './infrastructure/persistence/attendance-event.repository';
import {
  ChildDailyStatusRepository,
  ListDailyStatusFilter,
} from './infrastructure/persistence/child-daily-status.repository';
import { TimelineEntryRepository } from './infrastructure/persistence/timeline-entry.repository';

const KG_TZ = 'Asia/Almaty';

/** Returns the trimmed value, or null when empty/whitespace-only/absent. */
function nonBlankOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export interface CheckInOpts {
  recordedAt?: Date;
  notes?: string | null;
}

export interface CheckOutOpts {
  recordedAt?: Date;
  notes?: string | null;
  /**
   * B11 OTP-pickup branch. When non-null, the caller (PickupRequestService)
   * has already validated the OTP against the trusted-person row and is
   * recording the attendance event as the side-effect. In that branch:
   *   - `pickupUserId` is allowed to be null (the picker is a non-user
   *     trusted person, only known by phone snapshot on the request),
   *   - the pickup-guardian validation is SKIPPED — caller has already
   *     gated the operation via the trusted-people whitelist + OTP.
   * `method` defaults to `manual` for the existing staff-driven flow; B11
   * passes `otp_pickup` so the audit trail records how the row was created.
   */
  pickupRequestId?: string | null;
  method?: AttendanceMethod;
}

export interface PatchAttendanceEventInput {
  recordedAt?: Date;
  notes?: string | null;
  pickupUserId?: string;
}

export interface SetDailyStatusInput {
  childId: string;
  /** ISO date string YYYY-MM-DD. */
  date: string;
  status: string;
  note?: string | null;
}

export interface AttendanceFlowResult {
  event: AttendanceEvent;
  dailyStatus: ChildDailyStatus | null;
  timelineEntry: TimelineEntry;
}

/**
 * Aggregate donut counts for one calendar day. Mirrors the dashboard
 * attendance-today shape and adds the `late` bucket (sourced from the
 * `child_daily_status` histogram, which already groups by every status).
 */
export interface AttendanceDaySummaryResult {
  in_kindergarten: number;
  checked_out: number;
  absent: number;
  on_vacation: number;
  sick: number;
  late: number;
}

export interface PatchEventOpts {
  isAdmin: boolean;
}

/**
 * AttendanceService — single entry point for the B8 attendance + daily-status
 * + timeline aggregate.
 *
 * Atomic 3-table flow (checkIn / checkOut):
 *   The service does NOT open its own `dataSource.transaction(...)`. The
 *   request is already running inside the ambient TX opened by
 *   `TenantContextInterceptor`, which also pushes the tenant-scoped
 *   `EntityManager` into AsyncLocalStorage. All three repos pick that
 *   manager up, so the INSERT INTO attendance_events + INSERT INTO
 *   timeline_entries + UPSERT child_daily_status sequence is atomic without
 *   any wrapping here.
 *
 * Post-commit notifications (B9 outbox):
 *   Each public method awaits the NotificationPort call inside the same
 *   ambient TX that wraps the handler. `OutboxNotificationAdapter` writes a
 *   row to `notification_outbox` via the request-scoped EntityManager from
 *   `tenantStorage`, so the outbox row is committed atomically with the
 *   business mutation. If the mutation rolls back the outbox row rolls back
 *   too — no phantom events. The worker process later fans the outbox row
 *   out to WS + push.
 *
 * Per-method side-effects:
 *   checkIn         — INSERT event + timeline; UPSERT daily_status if
 *                     promotable (absent | late → present); notify.
 *   checkOut        — validate pickup; INSERT event + timeline; daily_status
 *                     UNCHANGED (per spec); notify.
 *   patchEvent      — UPDATE event in place (recorded_at | notes | pickup);
 *                     non-admin must be inside same calendar day in
 *                     Asia/Almaty. No notification (silent edit).
 *   setDailyStatus  — UPSERT daily_status; notify.
 *   listEventsBy*   — read-only.
 */
@Injectable()
export class AttendanceService {
  constructor(
    private readonly eventRepo: AttendanceEventRepository,
    private readonly dailyStatusRepo: ChildDailyStatusRepository,
    private readonly timelineRepo: TimelineEntryRepository,
    private readonly childRepo: ChildRepository,
    private readonly guardianRepo: ChildGuardianRepository,
    private readonly staffRepo: StaffMemberRepository,
    @Inject(ClockPort) private readonly clock: ClockPort,
    @Inject(NotificationPort)
    private readonly notifications: NotificationPort,
    // Identity-overlay deps. Optional + appended last so the existing
    // service-unit wiring (positional `new AttendanceService(...)`) keeps
    // compiling. Resolvers fail closed (empty map / null) when undefined.
    //   - `users` resolves the pickup user (`users.id → users.full_name`).
    //   - `staffService` reuses the staff identity fallback
    //     (`staff_members.full_name ?? users.full_name`) for `recorded_by`
    //     / `set_by` (both `staff_members.id`).
    @Optional()
    private readonly users?: UserRepository,
    @Optional()
    private readonly staffService?: StaffService,
  ) {}

  // ── Check-in / Check-out ───────────────────────────────────────────────

  async checkIn(
    kindergartenId: string,
    childId: string,
    callerUserId: string,
    opts: CheckInOpts = {},
  ): Promise<AttendanceFlowResult> {
    const recordedAt = opts.recordedAt ?? this.clock.now();
    this.assertNotFuture(recordedAt);

    const staff = await this.resolveCallerStaffMemberId(
      kindergartenId,
      callerUserId,
    );
    await this.assertChildExists(kindergartenId, childId);

    // 1) attendance_events
    const event = await this.eventRepo.create(
      kindergartenId,
      AttendanceEvent.createCheckIn(
        {
          id: randomUUID(),
          kindergartenId,
          childId,
          method: AttendanceMethod.MANUAL,
          recordedBy: staff,
          notes: opts.notes ?? null,
          recordedAt,
        },
        this.clock,
      ),
    );

    // 2) timeline_entries
    const timeline = await this.timelineRepo.create(
      kindergartenId,
      TimelineEntry.createNew(
        {
          id: randomUUID(),
          kindergartenId,
          childId,
          entryType: TimelineEntryType.CHECK_IN,
          title: 'Check-in',
          recordedBy: staff,
          entryTime: recordedAt,
        },
        this.clock,
      ),
    );

    // 3) child_daily_status — race-safe conditional-promotion path.
    //
    //   * No row → INSERT-or-CONFLICT-update through `upsert` (one-statement
    //     atomic; the unique idx on (child_id, date) means a concurrent
    //     INSERT loses cleanly via the ON CONFLICT clause).
    //   * Row exists → atomic conditional UPDATE that flips `absent|late →
    //     present` only. If a concurrent setter already moved the row to
    //     `sick` / `on_vacation` (or any non-promotable status), the UPDATE
    //     affects 0 rows and we surface whatever's currently in the DB.
    //     This replaces the previous read-then-`save()` flow which could
    //     overwrite a concurrent explicit status.
    const isoDate = formatLocalIsoDate(recordedAt, KG_TZ);
    const existing = await this.dailyStatusRepo.findByChildAndDate(
      kindergartenId,
      childId,
      isoDate,
    );
    let dailyStatus: ChildDailyStatus | null = existing;
    if (existing === null) {
      dailyStatus = await this.dailyStatusRepo.upsert(
        kindergartenId,
        ChildDailyStatus.createNew(
          {
            id: randomUUID(),
            kindergartenId,
            childId,
            date: isoDate,
            status: ChildIntradayStatus.PRESENT,
            note: null,
            setBy: staff,
          },
          this.clock,
        ),
      );
    } else {
      const { current } =
        await this.dailyStatusRepo.updatePresentIfAbsentOrLate(
          kindergartenId,
          childId,
          isoDate,
          staff,
          this.clock.now(),
        );
      // `updated=false` is NOT an error: the row was either already
      // `present` (idempotent re-check-in) or held a non-promotable
      // explicit status (`sick`, `on_vacation`, …) set concurrently.
      // Either way, surface the post-statement DB row so the service's
      // return value reflects ground truth.
      dailyStatus = current ?? existing;
    }

    // 4) outbox notification — atomic with the attendance write (same TX).
    await this.notifications.notifyAttendanceCheckIn({
      kindergartenId,
      childId,
      eventId: event.id,
      recordedAt: event.recordedAt,
      recordedByStaffMemberId: event.recordedBy,
    });
    await this.notifications.notifyTimelineEntryCreated({
      kindergartenId,
      childId,
      entryId: timeline.id,
      entryType: timeline.entryType.value,
      entryTime: timeline.entryTime,
      recordedByStaffMemberId: timeline.recordedBy,
    });

    return { event, dailyStatus, timelineEntry: timeline };
  }

  async checkOut(
    kindergartenId: string,
    childId: string,
    callerUserId: string,
    pickupUserId: string | null,
    opts: CheckOutOpts = {},
  ): Promise<AttendanceFlowResult> {
    const recordedAt = opts.recordedAt ?? this.clock.now();
    this.assertNotFuture(recordedAt);

    const staff = await this.resolveCallerStaffMemberId(
      kindergartenId,
      callerUserId,
    );
    await this.assertChildExists(kindergartenId, childId);

    const pickupRequestId = opts.pickupRequestId ?? null;
    const method = opts.method ?? AttendanceMethod.MANUAL;

    // B11 OTP-pickup branch skips guardian validation — the caller
    // (PickupRequestService) has already gated the operation through the
    // trusted-person whitelist + OTP. The legacy staff-driven branch keeps
    // the strict pickup-guardian assertion.
    if (pickupRequestId === null) {
      if (pickupUserId === null) {
        throw new InvalidAttendancePickupError(
          'pickupUserId is required when pickupRequestId is null',
        );
      }
      // Validate pickup BEFORE writing — throws PickupUserNotAllowedError when
      // the (child, pickupUser) is not an approved active pickup guardian.
      // No rows have been written, so a thrown exception is safe.
      await this.assertPickupAllowed(kindergartenId, childId, pickupUserId);
    }

    const event = await this.eventRepo.create(
      kindergartenId,
      AttendanceEvent.createCheckOut(
        {
          id: randomUUID(),
          kindergartenId,
          childId,
          method,
          recordedBy: staff,
          pickupUserId,
          pickupRequestId,
          notes: opts.notes ?? null,
          recordedAt,
        },
        this.clock,
      ),
    );

    const timeline = await this.timelineRepo.create(
      kindergartenId,
      TimelineEntry.createNew(
        {
          id: randomUUID(),
          kindergartenId,
          childId,
          entryType: TimelineEntryType.CHECK_OUT,
          title: 'Check-out',
          recordedBy: staff,
          entryTime: recordedAt,
        },
        this.clock,
      ),
    );

    // Per spec: check_out does NOT mutate child_daily_status. The intra-day
    // status only flips on check_in or via explicit setDailyStatus.

    await this.notifications.notifyAttendanceCheckOut({
      kindergartenId,
      childId,
      eventId: event.id,
      recordedAt: event.recordedAt,
      recordedByStaffMemberId: event.recordedBy,
      pickupUserId,
      pickupRequestId,
    });
    await this.notifications.notifyTimelineEntryCreated({
      kindergartenId,
      childId,
      entryId: timeline.id,
      entryType: timeline.entryType.value,
      entryTime: timeline.entryTime,
      recordedByStaffMemberId: timeline.recordedBy,
    });

    return { event, dailyStatus: null, timelineEntry: timeline };
  }

  // ── PATCH event ────────────────────────────────────────────────────────

  async patchEvent(
    kindergartenId: string,
    eventId: string,
    callerUserId: string,
    patch: PatchAttendanceEventInput,
    opts: PatchEventOpts,
  ): Promise<AttendanceEvent> {
    // Resolve staff member to ensure the caller has a valid active record
    // in this tenant (defence-in-depth — RolesGuard already gate-keeps).
    await this.resolveCallerStaffMemberId(kindergartenId, callerUserId);

    if (patch.recordedAt !== undefined) {
      this.assertNotFuture(patch.recordedAt);
    }

    const event = await this.eventRepo.findById(kindergartenId, eventId);
    if (event === null) {
      throw new AttendanceEventNotFoundError(eventId);
    }

    if (!opts.isAdmin) {
      // TODO(B22): make window configurable per kindergarten settings.
      const now = this.clock.now();
      const recordedDay = formatLocalIsoDate(event.recordedAt, KG_TZ);
      const todayDay = formatLocalIsoDate(now, KG_TZ);
      if (recordedDay !== todayDay) {
        throw new AttendanceEditWindowExpiredError(
          eventId,
          event.recordedAt,
          now,
        );
      }
    }

    if (patch.pickupUserId !== undefined) {
      // Disallow patching a pickup user onto a check-in row.
      if (event.eventType.value === 'check_in') {
        throw new InvalidAttendancePickupError(
          `cannot set pickup_user_id on a check_in event (${eventId})`,
        );
      }
      if (patch.pickupUserId !== event.pickupUserId) {
        await this.assertPickupAllowed(
          kindergartenId,
          event.childId,
          patch.pickupUserId,
        );
      }
    }

    event.applyPatch({
      recordedAt: patch.recordedAt,
      notes: patch.notes,
      pickupUserId: patch.pickupUserId,
    });

    return await this.eventRepo.update(kindergartenId, event);
  }

  // ── setDailyStatus ─────────────────────────────────────────────────────

  async setDailyStatus(
    kindergartenId: string,
    callerUserId: string,
    input: SetDailyStatusInput,
  ): Promise<ChildDailyStatus> {
    const staff = await this.resolveCallerStaffMemberId(
      kindergartenId,
      callerUserId,
    );
    await this.assertChildExists(kindergartenId, input.childId);

    const status = ChildIntradayStatus.from(input.status);
    const upserted = await this.dailyStatusRepo.upsert(
      kindergartenId,
      ChildDailyStatus.createNew(
        {
          id: randomUUID(),
          kindergartenId,
          childId: input.childId,
          date: input.date,
          status,
          note: input.note ?? null,
          setBy: staff,
        },
        this.clock,
      ),
    );

    await this.notifications.notifyDailyStatusChanged({
      kindergartenId,
      childId: input.childId,
      date: input.date,
      status: status.value,
      setByStaffMemberId: staff,
    });

    return upserted;
  }

  // ── List ───────────────────────────────────────────────────────────────

  async listEventsByChild(
    kindergartenId: string,
    childId: string,
    paging: ListAttendanceEventsByChildFilter = {},
  ): Promise<AttendanceEvent[]> {
    return await this.eventRepo.listByChild(kindergartenId, childId, paging);
  }

  async listEventsByGroup(
    kindergartenId: string,
    groupId: string,
    range: Omit<ListAttendanceEventsByGroupFilter, 'groupId'> = {},
  ): Promise<AttendanceEvent[]> {
    return await this.eventRepo.listByGroup(kindergartenId, {
      groupId,
      ...range,
    });
  }

  // ── T4 additional read methods ─────────────────────────────────────────

  /**
   * Get a single attendance event by id. Returns null if not found.
   * Used by admin-attendance.controller GET /admin/attendance-events/:eventId.
   */
  async getEventById(
    kindergartenId: string,
    eventId: string,
  ): Promise<AttendanceEvent> {
    const event = await this.eventRepo.findById(kindergartenId, eventId);
    if (event === null) {
      throw new AttendanceEventNotFoundError(eventId);
    }
    return event;
  }

  /**
   * Paged list of attendance events with optional child/group/date filters.
   * Used by admin dashboard.
   */
  async listEvents(
    kindergartenId: string,
    filter: {
      childId?: string;
      groupId?: string;
      from?: Date;
      to?: Date;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<AttendanceEvent[]> {
    if (filter.groupId) {
      return this.eventRepo.listByGroup(kindergartenId, {
        groupId: filter.groupId,
        from: filter.from,
        to: filter.to,
        limit: filter.limit,
        offset: filter.offset,
      });
    }
    if (filter.childId) {
      return this.eventRepo.listByChild(kindergartenId, filter.childId, {
        from: filter.from,
        to: filter.to,
        limit: filter.limit,
        offset: filter.offset,
      });
    }
    // No child/group filter — kg-wide. Previously this fell through to
    // listByChild('') and crashed with `invalid input syntax for type uuid`
    // (T6 H1). Use the dedicated repo method which omits the child predicate.
    return this.eventRepo.listByKindergarten(kindergartenId, {
      from: filter.from,
      to: filter.to,
      limit: filter.limit,
      offset: filter.offset,
    });
  }

  /**
   * Paged list of daily_status rows with optional filters. Used by
   * GET /admin/daily-status.
   */
  async listDailyStatuses(
    kindergartenId: string,
    filter: ListDailyStatusFilter,
  ): Promise<ChildDailyStatus[]> {
    return this.dailyStatusRepo.list(kindergartenId, filter);
  }

  /**
   * Get a single daily_status record by child + date. Returns null when no
   * record exists for that day (child was never checked in and no status
   * was explicitly set). Throws DailyStatusNotFoundError if child does not
   * exist in this kg.
   */
  async getDailyStatusByChildAndDate(
    kindergartenId: string,
    childId: string,
    date: string,
  ): Promise<ChildDailyStatus | null> {
    await this.assertChildExists(kindergartenId, childId);
    return this.dailyStatusRepo.findByChildAndDate(
      kindergartenId,
      childId,
      date,
    );
  }

  // ── B-DASH — attendance-today aggregate (shared with DashboardService) ──

  /**
   * Aggregate donut counts for one Asia/Almaty calendar day, scoped to the
   * kindergarten (optionally a single group). This is the single source of
   * truth behind both the admin dashboard (`DashboardService.getAttendanceToday`
   * delegates here) and the staff `GET /staff/attendance/today` endpoint.
   *
   * `in_kindergarten` / `checked_out` come from the per-child last-event-of-day
   * buckets; `absent` (with the no-check_in exclusion), `on_vacation`, `sick`
   * and `late` come from the `child_daily_status` histogram. Both repo methods
   * resolve their own tenant-scoped EntityManager so RLS stays intact; they run
   * in parallel via `Promise.all`.
   *
   * Day boundaries are the half-open UTC instant window for the Asia/Almaty
   * calendar `date` ([day 00:00 Almaty, next-day 00:00 Almaty)), computed by
   * the module-local `almatyDayStartUtc` helper — identical math to
   * `DashboardService`.
   */
  async getDaySummary(
    kindergartenId: string,
    opts: { groupId?: string; date?: string } = {},
  ): Promise<AttendanceDaySummaryResult> {
    const date = opts.date ?? almatyToday(this.clock.now());
    const dayStartIso = almatyDayStartUtc(date).toISOString();
    const dayEndExclusiveIso = almatyDayStartUtc(date, 1).toISOString();

    const [statusCounts, eventBuckets] = await Promise.all([
      this.dailyStatusRepo.countByStatusForDate(
        kindergartenId,
        date,
        dayStartIso,
        dayEndExclusiveIso,
        opts.groupId,
      ),
      this.eventRepo.lastEventBucketsForDate(
        kindergartenId,
        dayStartIso,
        dayEndExclusiveIso,
        opts.groupId,
      ),
    ]);

    return {
      in_kindergarten: eventBuckets.inKindergarten,
      checked_out: eventBuckets.checkedOut,
      absent: statusCounts['absent'] ?? 0,
      on_vacation: statusCounts['on_vacation'] ?? 0,
      sick: statusCounts['sick'] ?? 0,
      late: statusCounts['late'] ?? 0,
    };
  }

  // ── identity overlays ──────────────────────────────────────────────────

  /**
   * Identity overlay for check-out events — resolves each event's
   * `pickup_user_id` (a `users.id`) to a display name via
   * `users.full_name`. Mirrors `ProgressNoteService.resolveMentorNames`:
   * distinct ids are looked up once and returned as a map keyed by
   * `pickup_user_id`.
   *
   * Only check_out events carry a `pickup_user_id`; check_in rows have null
   * and are skipped. Blank/whitespace-only names collapse to null so the
   * client can fall back cleanly. Fails closed: if the `users` port is not
   * wired (legacy spec construction) or a user row is missing, that entry
   * resolves to null.
   */
  async resolvePickupUserNames(
    events: AttendanceEvent[],
  ): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    if (!this.users) {
      return out;
    }
    const distinctUserIds = [
      ...new Set(
        events
          .map((e) => e.pickupUserId)
          .filter((id): id is string => id !== null && id !== undefined),
      ),
    ];
    for (const userId of distinctUserIds) {
      const user = await this.users.findById(userId);
      out.set(userId, nonBlankOrNull(user?.toState()?.fullName));
    }
    return out;
  }

  /**
   * Identity overlay keyed by `staff_members.id` — resolves each id to a
   * display name via the staff identity fallback
   * (`staff_members.full_name ?? users.full_name`, reusing
   * `StaffService.resolveIdentity`). Shared by the `recorded_by` overlay on
   * attendance events and the `set_by` overlay on daily-status rows.
   *
   * Fails closed: when the staff ports are not wired (legacy spec
   * construction) or a staff row is missing, that entry resolves to null.
   */
  async resolveStaffMemberNames(
    kindergartenId: string,
    staffMemberIds: (string | null)[],
  ): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    if (!this.staffService) {
      return out;
    }
    const distinctIds = [
      ...new Set(
        staffMemberIds.filter(
          (id): id is string => id !== null && id !== undefined,
        ),
      ),
    ];
    for (const staffMemberId of distinctIds) {
      const member = await this.staffRepo.findById(
        kindergartenId,
        staffMemberId,
      );
      if (!member) {
        out.set(staffMemberId, null);
        continue;
      }
      const identity = await this.staffService.resolveIdentity(member);
      out.set(staffMemberId, nonBlankOrNull(identity.fullName));
    }
    return out;
  }

  /** `recorded_by` overlay for attendance events / timeline (staff names). */
  async resolveRecordedByNames(
    kindergartenId: string,
    events: { recordedBy: string | null }[],
  ): Promise<Map<string, string | null>> {
    return this.resolveStaffMemberNames(
      kindergartenId,
      events.map((e) => e.recordedBy),
    );
  }

  /**
   * `child_name` overlay for attendance events — resolves each event's
   * `child_id` to `children.full_name` (INCLUDING archived children) within
   * the caller kg, batched + deduped. Reuses the already-injected
   * `ChildRepository.findFullNamesByIds` (the same batch resolver the
   * diagnostics / parent-request `child_name` overlays consume). Returns a
   * `Map<childId, full_name>`; ids missing from the map (missing /
   * cross-tenant child rows) render `child_name` as null.
   */
  async resolveChildNames(
    kindergartenId: string,
    events: { childId: string }[],
  ): Promise<Map<string, string>> {
    return this.childRepo.findFullNamesByIds(
      kindergartenId,
      events.map((e) => e.childId),
    );
  }

  /** `set_by` overlay for daily-status rows (staff names). */
  async resolveSetByNames(
    kindergartenId: string,
    rows: { setBy: string | null }[],
  ): Promise<Map<string, string | null>> {
    return this.resolveStaffMemberNames(
      kindergartenId,
      rows.map((r) => r.setBy),
    );
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private async resolveCallerStaffMemberId(
    kindergartenId: string,
    callerUserId: string,
  ): Promise<string> {
    const staff = await this.staffRepo.findActiveByUserAndKindergarten(
      callerUserId,
      kindergartenId,
    );
    if (!staff) throw new StaffNotFoundError(callerUserId);
    return staff.id;
  }

  private async assertChildExists(
    kindergartenId: string,
    childId: string,
  ): Promise<void> {
    const child = await this.childRepo.findById(kindergartenId, childId);
    if (child === null) {
      throw new ChildNotFoundError(childId);
    }
  }

  private async assertPickupAllowed(
    kindergartenId: string,
    childId: string,
    pickupUserId: string,
  ): Promise<void> {
    const guardian = await this.guardianRepo.findApprovedActivePickupGuardian(
      kindergartenId,
      childId,
      pickupUserId,
    );
    if (guardian === null) {
      throw new PickupUserNotAllowedError(childId, pickupUserId);
    }
  }

  /**
   * Reject `recorded_at` / `entry_time` values more than 5 minutes in the
   * future. A small skew tolerance accounts for clients with mildly
   * unsynchronised clocks. Throws InvalidAttendanceTimestampError → 422.
   * Used by checkIn / checkOut / patchEvent (T6 M3 fix-pass).
   */
  private assertNotFuture(when: Date): void {
    const now = this.clock.now();
    const SKEW_MS = 5 * 60 * 1000;
    if (when.getTime() > now.getTime() + SKEW_MS) {
      throw new InvalidAttendanceTimestampError(when, now);
    }
  }
}

/**
 * Format a Date as ISO `YYYY-MM-DD` in the given timezone. Uses
 * `toLocaleDateString('en-CA', { timeZone })` because en-CA already produces
 * the ISO format natively. No date-fns/luxon dep needed.
 */
function formatLocalIsoDate(d: Date, timeZone: string): string {
  return d.toLocaleDateString('en-CA', { timeZone });
}

/**
 * Asia/Almaty is UTC+5 with no DST, so a local civil date is just the UTC
 * instant shifted by +5h; a local midnight is the UTC instant shifted back by
 * −5h. Identical constant + math to `DashboardService` — kept in sync so both
 * the dashboard and the staff attendance-today endpoint resolve the same day
 * boundaries.
 */
const ALMATY_OFFSET_MS = 5 * 60 * 60 * 1000;

/** Asia/Almaty civil date (`YYYY-MM-DD`) for the given UTC instant. */
function almatyToday(nowUtc: Date): string {
  const shifted = new Date(nowUtc.getTime() + ALMATY_OFFSET_MS);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(
    shifted.getUTCMonth() + 1,
  )}-${pad(shifted.getUTCDate())}`;
}

/**
 * UTC instant of an Asia/Almaty-local midnight for the given calendar date
 * (`YYYY-MM-DD`), optionally offset by whole days. `addDays = 1` on the range
 * `to` yields the exclusive upper bound of an inclusive day range.
 */
function almatyDayStartUtc(dateStr: string, addDays = 0): Date {
  const [y, m, d] = dateStr.split('-').map((p) => Number(p));
  return new Date(Date.UTC(y, m - 1, d + addDays) - ALMATY_OFFSET_MS);
}
