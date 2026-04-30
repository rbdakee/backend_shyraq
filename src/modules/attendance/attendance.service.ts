import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { NotificationPort } from '@/common/notifications/notification.port';
import { ChildNotFoundError } from '@/modules/child/domain/errors/child-not-found.error';
import { ChildGuardianRepository } from '@/modules/child/infrastructure/persistence/child-guardian.repository';
import { ChildRepository } from '@/modules/child/infrastructure/persistence/child.repository';
import { StaffNotFoundError } from '@/modules/staff/domain/errors/staff-not-found.error';
import { StaffMemberRepository } from '@/modules/staff/infrastructure/persistence/staff-member.repository';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { AttendanceEvent } from './domain/entities/attendance-event.entity';
import { ChildDailyStatus } from './domain/entities/child-daily-status.entity';
import { TimelineEntry } from './domain/entities/timeline-entry.entity';
import { AttendanceEditWindowExpiredError } from './domain/errors/attendance-edit-window-expired.error';
import { AttendanceEventNotFoundError } from './domain/errors/attendance-event-not-found.error';
import { InvalidAttendancePickupError } from './domain/errors/invalid-attendance-pickup.error';
import { PickupUserNotAllowedError } from './domain/errors/pickup-user-not-allowed.error';
import { AttendanceMethod } from './domain/value-objects/attendance-method.vo';
import { ChildIntradayStatus } from './domain/value-objects/child-intraday-status.vo';
import { TimelineEntryType } from './domain/value-objects/timeline-entry-type.vo';
import {
  AttendanceEventRepository,
  ListAttendanceEventsByChildFilter,
  ListAttendanceEventsByGroupFilter,
} from './infrastructure/persistence/attendance-event.repository';
import { ChildDailyStatusRepository } from './infrastructure/persistence/child-daily-status.repository';
import { TimelineEntryRepository } from './infrastructure/persistence/timeline-entry.repository';

const KG_TZ = 'Asia/Almaty';

export interface CheckInOpts {
  recordedAt?: Date;
  notes?: string | null;
}

export interface CheckOutOpts {
  recordedAt?: Date;
  notes?: string | null;
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
 * Post-commit notifications:
 *   Each public method captures the event payload AFTER the repo writes
 *   complete and BEFORE returning. Because the ambient TX wraps the whole
 *   handler (interceptor commits on resolve, rolls back on throw), calling
 *   the NotificationPort from inside the service body still happens inside
 *   the TX. To keep notifications outside the TX (so a slow logger or a
 *   broken adapter cannot rollback the audit row), we defer the notify call
 *   onto a microtask via `Promise.resolve().then(...)` and swallow any
 *   error — fire-and-forget. Service.ts callers do not `await` the
 *   notification.
 *
 *   This pattern matches the post-commit dispatch in B7 ScheduleService and
 *   the B7 T7 review fixes (see commit b27b5dc).
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
  ) {}

  // ── Check-in / Check-out ───────────────────────────────────────────────

  async checkIn(
    kindergartenId: string,
    childId: string,
    callerUserId: string,
    opts: CheckInOpts = {},
  ): Promise<AttendanceFlowResult> {
    const recordedAt = opts.recordedAt ?? this.clock.now();

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

    // 3) child_daily_status — read-then-conditional-write.
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
    } else if (existing.markPresent(staff, this.clock)) {
      dailyStatus = await this.dailyStatusRepo.save(kindergartenId, existing);
    }

    // 4) post-commit notification (fire-and-forget, never awaited inside TX).
    this.fireAndForget(() =>
      this.notifications.notifyAttendanceCheckIn({
        kindergartenId,
        childId,
        eventId: event.id,
        recordedAt: event.recordedAt,
        recordedByStaffMemberId: event.recordedBy,
      }),
    );
    this.fireAndForget(() =>
      this.notifications.notifyTimelineEntryCreated({
        kindergartenId,
        childId,
        entryId: timeline.id,
        entryType: timeline.entryType.value,
        entryTime: timeline.entryTime,
        recordedByStaffMemberId: timeline.recordedBy,
      }),
    );

    return { event, dailyStatus, timelineEntry: timeline };
  }

  async checkOut(
    kindergartenId: string,
    childId: string,
    callerUserId: string,
    pickupUserId: string,
    opts: CheckOutOpts = {},
  ): Promise<AttendanceFlowResult> {
    const recordedAt = opts.recordedAt ?? this.clock.now();

    const staff = await this.resolveCallerStaffMemberId(
      kindergartenId,
      callerUserId,
    );
    await this.assertChildExists(kindergartenId, childId);

    // Validate pickup BEFORE writing — throws PickupUserNotAllowedError when
    // the (child, pickupUser) is not an approved active pickup guardian.
    // No rows have been written, so a thrown exception is safe.
    await this.assertPickupAllowed(kindergartenId, childId, pickupUserId);

    const event = await this.eventRepo.create(
      kindergartenId,
      AttendanceEvent.createCheckOut(
        {
          id: randomUUID(),
          kindergartenId,
          childId,
          method: AttendanceMethod.MANUAL,
          recordedBy: staff,
          pickupUserId,
          pickupRequestId: null, // B11 will set this when OTP-pickup lands.
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

    this.fireAndForget(() =>
      this.notifications.notifyAttendanceCheckOut({
        kindergartenId,
        childId,
        eventId: event.id,
        recordedAt: event.recordedAt,
        recordedByStaffMemberId: event.recordedBy,
        pickupUserId,
        pickupRequestId: null,
      }),
    );
    this.fireAndForget(() =>
      this.notifications.notifyTimelineEntryCreated({
        kindergartenId,
        childId,
        entryId: timeline.id,
        entryType: timeline.entryType.value,
        entryTime: timeline.entryTime,
        recordedByStaffMemberId: timeline.recordedBy,
      }),
    );

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

    this.fireAndForget(() =>
      this.notifications.notifyDailyStatusChanged({
        kindergartenId,
        childId: input.childId,
        date: input.date,
        status: status.value,
        setByStaffMemberId: staff,
      }),
    );

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
   * Schedule a notification call onto a microtask so the ambient transaction
   * is not held by an awaiting notify. Errors are caught and dropped — the
   * caller never observes the notification's success/failure (logged inside
   * the adapter). Mirrors the post-commit fire-and-forget pattern used by
   * the B7 services after the T7 review (commit b27b5dc).
   */
  private fireAndForget(work: () => Promise<void>): void {
    Promise.resolve()
      .then(() => work())
      .catch(() => {
        /* swallow — notifications must never break the user-facing flow */
      });
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
