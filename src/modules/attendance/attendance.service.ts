import { Inject, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { toAuditSnapshot } from '@/modules/audit/domain/entities/audit-log-entry.entity';
import { AuditService } from '@/modules/audit/audit.service';
import { NotificationPort } from '@/common/notifications/notification.port';
import { ChildNotFoundError } from '@/modules/child/domain/errors/child-not-found.error';
import { ChildGuardianRepository } from '@/modules/child/infrastructure/persistence/child-guardian.repository';
import { ChildRepository } from '@/modules/child/infrastructure/persistence/child.repository';
import { StaffNotFoundError } from '@/modules/staff/domain/errors/staff-not-found.error';
import { StaffMemberRepository } from '@/modules/staff/infrastructure/persistence/staff-member.repository';
import { StaffService } from '@/modules/staff/staff.service';
import { UserRepository } from '@/modules/users/infrastructure/persistence/user.repository';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import {
  AttendanceEvent,
  AttendanceEventState,
} from './domain/entities/attendance-event.entity';
import { ChildDailyStatus } from './domain/entities/child-daily-status.entity';
import { TimelineEntry } from './domain/entities/timeline-entry.entity';
import { AttendanceEditWindowExpiredError } from './domain/errors/attendance-edit-window-expired.error';
import { AttendanceEventNotFoundError } from './domain/errors/attendance-event-not-found.error';
import { InvalidAttendancePickupError } from './domain/errors/invalid-attendance-pickup.error';
import { InvalidAttendanceTimestampError } from './domain/errors/invalid-attendance-timestamp.error';
import { PickupUserNotAllowedError } from './domain/errors/pickup-user-not-allowed.error';
import { AttendanceCorrectionAdminOnlyError } from './domain/errors/attendance-correction-admin-only.error';
import {
  AttendanceEventType,
  AttendanceEventTypeValue,
} from './domain/value-objects/attendance-event-type.vo';
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

/**
 * Suppresses the parent-facing push/WS notification for this write. Default
 * (undefined) is `true` — the staff flow always notifies, unchanged.
 *
 * The admin flow passes `false` when back-filling a past day: a parent should
 * not get a "your child just arrived" push at 22:00 because the admin is
 * closing yesterday's register. The attendance row, timeline entry and audit
 * entry are still written — only the notification is skipped.
 */
interface NotifyOpt {
  notify?: boolean;
}

export interface CheckInOpts extends NotifyOpt {
  recordedAt?: Date;
  notes?: string | null;
}

export interface CheckOutOpts extends NotifyOpt {
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
  /**
   * Admin-only. Re-points the event at another child (filed against the wrong
   * kid). Non-admin callers get `attendance_correction_admin_only`.
   */
  childId?: string;
  /** Admin-only. Flips check_in ⇄ check_out (mis-pressed button). */
  eventType?: AttendanceEventTypeValue;
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

/**
 * The caller's authority over a patch, split into the two independent things
 * it actually governs.
 *
 * These were one `isAdmin` flag. That was already imprecise — it only ever
 * meant "skip the edit window", and `reception` gets that through the admin
 * route by design. Once child_id / event_type became patchable, the single
 * flag would have handed reception the structural corrections too, so the two
 * concerns are now named separately and granted separately.
 */
export interface PatchEventOpts {
  /**
   * Skips the same-calendar-day (Asia/Almaty) edit window. True on the admin
   * route for both admin and reception — front-desk staff correcting an
   * earlier day is the point of that route.
   */
  skipEditWindow: boolean;
  /**
   * Permits the `child_id` / `event_type` corrections. Admin only: they
   * re-point the row onto another child or flip its direction, cascading into
   * daily_status and the parent-visible timeline.
   */
  allowStructuralCorrection: boolean;
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
 * Audit trail:
 *   Every mutation writes an `audit_log` row through `AuditService` inside the
 *   same ambient TX, carrying actor + before/after snapshots. This is what
 *   permits child_id / event_type to be editable at all (see
 *   `AttendanceEvent`'s docblock) — history lives in audit_log, not in the
 *   row's immutability. Do not add a mutation path here without an audit
 *   write.
 *
 * Per-method side-effects:
 *   checkIn         — INSERT event + timeline; UPSERT daily_status if
 *                     promotable (absent | late → present); audit(create);
 *                     notify unless opts.notify === false.
 *   checkOut        — validate pickup; INSERT event + timeline; daily_status
 *                     UNCHANGED (per spec); audit(create); notify unless
 *                     opts.notify === false.
 *   patchEvent      — UPDATE event in place (recorded_at | notes | pickup,
 *                     plus admin-only child_id | event_type); cascades to the
 *                     paired timeline entry and recomputes daily_status for
 *                     every affected (child, day); audit(update). Non-admin
 *                     must be inside same calendar day in Asia/Almaty. No
 *                     notification (silent edit).
 *   deleteEvent     — admin-only soft-delete; removes the paired timeline
 *                     entry; recomputes daily_status; audit(delete). Silent.
 *   setDailyStatus  — UPSERT daily_status; audit(create|update); notify.
 *   listEventsBy*   — read-only; live rows only (see the repository port).
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
    // Required, NOT @Optional — an unwired audit port must fail loudly at
    // boot rather than silently drop the mutation trail. That is also why it
    // sits before the optional overlay deps (TS forbids a required parameter
    // after an optional one).
    private readonly audit: AuditService,
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

    // 2) timeline_entries — linked back to the event so an admin correction
    //    (delete / re-point onto another child) can cascade to this row.
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
          sourceEventId: event.id,
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

    // 4) audit trail — atomic with the write (same TX).
    await this.audit.record({
      kindergartenId,
      entityType: 'attendance_event',
      entityId: event.id,
      action: 'create',
      actorUserId: callerUserId,
      actorStaffId: staff,
      after: toAuditSnapshot(event.toState()),
    });

    // 5) outbox notification — atomic with the attendance write (same TX).
    if (opts.notify !== false) {
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
    }

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
          sourceEventId: event.id,
        },
        this.clock,
      ),
    );

    // Per spec: check_out does NOT mutate child_daily_status. The intra-day
    // status only flips on check_in or via explicit setDailyStatus.

    await this.audit.record({
      kindergartenId,
      entityType: 'attendance_event',
      entityId: event.id,
      action: 'create',
      actorUserId: callerUserId,
      actorStaffId: staff,
      after: toAuditSnapshot(event.toState()),
    });

    if (opts.notify !== false) {
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
    }

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
    const staff = await this.resolveCallerStaffMemberId(
      kindergartenId,
      callerUserId,
    );

    if (patch.recordedAt !== undefined) {
      this.assertNotFuture(patch.recordedAt);
    }

    const event = await this.eventRepo.findById(kindergartenId, eventId);
    if (event === null) {
      throw new AttendanceEventNotFoundError(eventId);
    }

    // child_id / event_type are structural corrections, not ordinary edits:
    // they cascade into daily_status and the parent-visible timeline.
    if (!opts.allowStructuralCorrection) {
      if (patch.childId !== undefined) {
        throw new AttendanceCorrectionAdminOnlyError(eventId, 'child_id');
      }
      if (patch.eventType !== undefined) {
        throw new AttendanceCorrectionAdminOnlyError(eventId, 'event_type');
      }
    }

    if (!opts.skipEditWindow) {
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

    // Snapshot BEFORE any mutation — this is what audit_log.before carries,
    // and what tells us which (child, date) buckets need recomputing.
    const before = event.toState();

    // Resolve the post-patch shape up front so every validation below reasons
    // about the row as it will END UP, not as it currently is. Patching
    // `pickupUserId` onto a row that is simultaneously flipped to check_out is
    // legal; onto one that stays check_in is not.
    const nextChildId = patch.childId ?? before.childId;
    const nextEventType =
      patch.eventType !== undefined
        ? AttendanceEventType.from(patch.eventType)
        : event.eventType;
    const nextPickupUserId =
      patch.pickupUserId !== undefined
        ? patch.pickupUserId
        : before.pickupUserId;

    if (patch.childId !== undefined && patch.childId !== before.childId) {
      await this.assertChildExists(kindergartenId, patch.childId);
    }

    if (
      patch.pickupUserId !== undefined &&
      nextEventType.value === 'check_in'
    ) {
      throw new InvalidAttendancePickupError(
        `cannot set pickup_user_id on a check_in event (${eventId})`,
      );
    }

    // Re-validate the (child, pickup user) pair whenever either side moves.
    // Re-pointing a check_out at another child MUST re-check the pickup
    // guardian — otherwise the row would claim child B was collected by
    // someone only approved for child A.
    if (nextEventType.value === 'check_out' && nextPickupUserId !== null) {
      const pairChanged =
        nextChildId !== before.childId ||
        nextPickupUserId !== before.pickupUserId;
      if (pairChanged) {
        await this.assertPickupAllowed(
          kindergartenId,
          nextChildId,
          nextPickupUserId,
        );
      }
    }

    event.applyPatch({
      recordedAt: patch.recordedAt,
      notes: patch.notes,
      pickupUserId: patch.pickupUserId,
      childId: patch.childId,
      eventType: patch.eventType !== undefined ? nextEventType : undefined,
    });

    const updated = await this.eventRepo.update(kindergartenId, event);

    await this.cascadeTimeline(kindergartenId, before, updated);
    await this.recomputeAffectedDailyStatuses(
      kindergartenId,
      before,
      updated.toState(),
      staff,
    );

    await this.audit.record({
      kindergartenId,
      entityType: 'attendance_event',
      entityId: eventId,
      action: 'update',
      actorUserId: callerUserId,
      actorStaffId: staff,
      before: toAuditSnapshot(before),
      after: toAuditSnapshot(updated.toState()),
    });

    return updated;
  }

  // ── DELETE event ───────────────────────────────────────────────────────

  /**
   * Soft-deletes an event filed by mistake, and unwinds its side-effects in
   * the same transaction: the paired timeline entry is removed (it is a mirror
   * of the event, not an independent record) and the affected child's
   * daily_status is recomputed.
   *
   * Authorization is the caller's: the only HTTP route in is
   * `DELETE /admin/attendance-events/:eventId`, which carries a method-level
   * `@Roles('admin')`. `audit_log.before` keeps the full pre-delete snapshot,
   * so the row remains reconstructible.
   */
  async deleteEvent(
    kindergartenId: string,
    eventId: string,
    callerUserId: string,
  ): Promise<void> {
    const staff = await this.resolveCallerStaffMemberId(
      kindergartenId,
      callerUserId,
    );

    const event = await this.eventRepo.findById(kindergartenId, eventId);
    if (event === null) {
      // Already soft-deleted rows read as absent — re-deleting is a 404, not
      // a silent no-op.
      throw new AttendanceEventNotFoundError(eventId);
    }

    const before = event.toState();

    event.softDelete(this.clock.now());
    await this.eventRepo.update(kindergartenId, event);

    const entry = await this.timelineRepo.findBySourceEventId(
      kindergartenId,
      eventId,
    );
    if (entry !== null) {
      await this.timelineRepo.delete(kindergartenId, entry.id);
    }

    await this.recomputeDailyStatus(
      kindergartenId,
      before.childId,
      formatLocalIsoDate(before.recordedAt, KG_TZ),
      staff,
    );

    await this.audit.record({
      kindergartenId,
      entityType: 'attendance_event',
      entityId: eventId,
      action: 'delete',
      actorUserId: callerUserId,
      actorStaffId: staff,
      before: toAuditSnapshot(before),
    });
  }

  /**
   * True when `recordedAt` falls on a calendar day other than today in
   * Asia/Almaty. The admin controller uses it to suppress the parent push on
   * a back-fill — see `NotifyOpt`. `undefined` (i.e. "now") is never
   * backdated.
   */
  isBackdated(recordedAt?: Date): boolean {
    if (recordedAt === undefined) return false;
    return (
      formatLocalIsoDate(recordedAt, KG_TZ) !==
      formatLocalIsoDate(this.clock.now(), KG_TZ)
    );
  }

  // ── Correction cascade ─────────────────────────────────────────────────

  /**
   * Realigns the timeline entry mirroring a corrected event.
   *
   * A changed child or recorded_at is a simple re-point. A flipped event_type
   * is not: `TimelineEntry.entryType` is immutable by design, so the entry is
   * replaced rather than mutated — the old row is deleted and a fresh one
   * created with the correct type, carrying the ORIGINAL author forward. That
   * keeps "an entry's type never changes" true while still producing the right
   * timeline. Note the replacement gets a new `id`, so a client holding a
   * deep-link to the old entry will 404.
   *
   * Entries predating `source_event_id` (or which the migration backfill could
   * not match) resolve to null; the correction proceeds without a cascade
   * rather than failing.
   */
  private async cascadeTimeline(
    kindergartenId: string,
    before: AttendanceEventState,
    updated: AttendanceEvent,
  ): Promise<void> {
    const entry = await this.timelineRepo.findBySourceEventId(
      kindergartenId,
      updated.id,
    );
    if (entry === null) return;

    const after = updated.toState();
    const typeFlipped = before.eventType !== after.eventType;

    if (!typeFlipped) {
      if (
        before.childId === after.childId &&
        before.recordedAt.getTime() === after.recordedAt.getTime()
      ) {
        return;
      }
      entry.applyPatch({
        childId: after.childId,
        entryTime: after.recordedAt,
      });
      await this.timelineRepo.update(kindergartenId, entry);
      return;
    }

    await this.timelineRepo.delete(kindergartenId, entry.id);
    const entryType =
      after.eventType === 'check_in'
        ? TimelineEntryType.CHECK_IN
        : TimelineEntryType.CHECK_OUT;
    await this.timelineRepo.create(
      kindergartenId,
      TimelineEntry.createNew(
        {
          id: randomUUID(),
          kindergartenId,
          childId: after.childId,
          entryType,
          title: after.eventType === 'check_in' ? 'Check-in' : 'Check-out',
          // The ORIGINAL author, not the admin doing the correcting. The entry
          // still records who was at the door; who fixed the paperwork is
          // audit_log's job. Using the corrector here would silently diverge
          // the entry's author from the event's immutable `recorded_by`.
          recordedBy: entry.recordedBy,
          entryTime: after.recordedAt,
          sourceEventId: updated.id,
        },
        this.clock,
      ),
    );
  }

  /**
   * Recomputes every (child, day) bucket a correction could have touched —
   * the one the event left and the one it landed in. They collapse to a
   * single recompute when neither child nor day moved.
   */
  private async recomputeAffectedDailyStatuses(
    kindergartenId: string,
    before: AttendanceEventState,
    after: AttendanceEventState,
    staff: string,
  ): Promise<void> {
    const buckets = new Map<string, { childId: string; date: string }>();
    for (const s of [before, after]) {
      const date = formatLocalIsoDate(s.recordedAt, KG_TZ);
      buckets.set(`${s.childId}|${date}`, { childId: s.childId, date });
    }
    for (const b of buckets.values()) {
      await this.recomputeDailyStatus(kindergartenId, b.childId, b.date, staff);
    }
  }

  /**
   * Re-derives one (child, date) daily_status from the surviving check_in
   * events for that day.
   *
   * Promotion mirrors `checkIn`: `absent|late → present` only.
   *
   * Demotion is deliberately narrow — `present → absent` ONLY when no live
   * check_in remains. Explicit operator decisions (`sick`, `on_vacation`,
   * `late`, `early_pickup`) are never overwritten: they outrank anything
   * inferred from the event log. The documented trade-off: a `present` that
   * staff set by hand WITHOUT a check-in is indistinguishable from one the
   * check-in produced, so deleting an unrelated event on that day demotes it
   * to `absent`.
   */
  private async recomputeDailyStatus(
    kindergartenId: string,
    childId: string,
    isoDate: string,
    staff: string,
  ): Promise<void> {
    const from = almatyDayStartUtc(isoDate);
    const to = almatyDayStartUtc(isoDate, 1);
    // Soft-deleted rows are already filtered out by the repository, so this
    // only ever sees live check-ins.
    const liveCheckIns = await this.eventRepo.listByChild(
      kindergartenId,
      childId,
      { from, to, eventType: 'check_in', limit: 1 },
    );
    const existing = await this.dailyStatusRepo.findByChildAndDate(
      kindergartenId,
      childId,
      isoDate,
    );

    if (liveCheckIns.length > 0) {
      if (existing === null) {
        await this.dailyStatusRepo.upsert(
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
        return;
      }
      await this.dailyStatusRepo.updatePresentIfAbsentOrLate(
        kindergartenId,
        childId,
        isoDate,
        staff,
        this.clock.now(),
      );
      return;
    }

    if (existing !== null && existing.status.value === 'present') {
      await this.dailyStatusRepo.upsert(
        kindergartenId,
        ChildDailyStatus.createNew(
          {
            id: existing.id,
            kindergartenId,
            childId,
            date: isoDate,
            status: ChildIntradayStatus.ABSENT,
            note: existing.note,
            setBy: staff,
          },
          this.clock,
        ),
      );
    }
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
    const previous = await this.dailyStatusRepo.findByChildAndDate(
      kindergartenId,
      input.childId,
      input.date,
    );
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

    // Upsert — so `create` on a fresh (child, date), `update` when overriding
    // an existing status. `before` is null in the create case.
    await this.audit.record({
      kindergartenId,
      entityType: 'child_daily_status',
      entityId: upserted.id,
      action: previous === null ? 'create' : 'update',
      actorUserId: callerUserId,
      actorStaffId: staff,
      before: previous ? toAuditSnapshot(previous.toState()) : null,
      after: toAuditSnapshot(upserted.toState()),
    });

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

  /** `actor_staff_id` overlay for audit_log rows (staff names). */
  async resolveActorNames(
    kindergartenId: string,
    rows: { actorStaffId: string | null }[],
  ): Promise<Map<string, string | null>> {
    return this.resolveStaffMemberNames(
      kindergartenId,
      rows.map((r) => r.actorStaffId),
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
