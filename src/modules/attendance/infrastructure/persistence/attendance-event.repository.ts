import { AttendanceEvent } from '../../domain/entities/attendance-event.entity';
import { AttendanceEventTypeValue } from '../../domain/value-objects/attendance-event-type.vo';

export interface ListAttendanceEventsByChildFilter {
  /** Inclusive lower bound on `recorded_at` (UTC). */
  from?: Date;
  /** Exclusive upper bound on `recorded_at` (UTC). */
  to?: Date;
  eventType?: AttendanceEventTypeValue;
  limit?: number;
  offset?: number;
}

export interface ListAttendanceEventsByGroupFilter {
  groupId: string;
  /** Inclusive lower bound on `recorded_at` (UTC). */
  from?: Date;
  /** Exclusive upper bound on `recorded_at` (UTC). */
  to?: Date;
  eventType?: AttendanceEventTypeValue;
  limit?: number;
  offset?: number;
}

export interface ListAttendanceEventsByKindergartenFilter {
  /** Inclusive lower bound on `recorded_at` (UTC). */
  from?: Date;
  /** Exclusive upper bound on `recorded_at` (UTC). */
  to?: Date;
  eventType?: AttendanceEventTypeValue;
  limit?: number;
  offset?: number;
}

/**
 * Port over `attendance_events`.
 *
 * There is no hard `delete` — removal is a soft-delete, expressed as an
 * `update` of an event whose `softDelete()` has been called. The row survives
 * so `audit_log.entity_id` keeps resolving.
 *
 * Consequence for implementors: EVERY read here returns live rows only
 * (`deleted_at IS NULL`). `findById` included — a tombstone must read as
 * absent so patch/delete of an already-deleted id surfaces
 * `attendance_event_not_found` instead of mutating it. A missed filter leaks
 * deleted events into the admin list and the dashboard donut counters.
 */
export abstract class AttendanceEventRepository {
  abstract create(
    kindergartenId: string,
    event: AttendanceEvent,
  ): Promise<AttendanceEvent>;

  abstract findById(
    kindergartenId: string,
    eventId: string,
  ): Promise<AttendanceEvent | null>;

  abstract update(
    kindergartenId: string,
    event: AttendanceEvent,
  ): Promise<AttendanceEvent>;

  abstract listByChild(
    kindergartenId: string,
    childId: string,
    filter: ListAttendanceEventsByChildFilter,
  ): Promise<AttendanceEvent[]>;

  /**
   * Group-scoped list. Joins `children` on `current_group_id` since
   * attendance_events itself does not carry a group_id (a child may have
   * been transferred mid-day; using the current group is the spec'd
   * behaviour for the live admin/staff dashboards).
   */
  abstract listByGroup(
    kindergartenId: string,
    filter: ListAttendanceEventsByGroupFilter,
  ): Promise<AttendanceEvent[]>;

  /**
   * Kindergarten-wide list (no child or group predicate). Used by the admin
   * `GET /admin/attendance-events` endpoint when no child/group filter is
   * supplied — previously the service degraded to `listByChild('')` which
   * caused `invalid input syntax for type uuid` (T6 H1). Same ORDER BY +
   * limit/offset semantics as `listByChild` / `listByGroup`.
   */
  abstract listByKindergarten(
    kindergartenId: string,
    filter: ListAttendanceEventsByKindergartenFilter,
  ): Promise<AttendanceEvent[]>;

  // ── B-DASH — Dashboard attendance-today aggregate ─────────────────────

  /**
   * Per-child last-event-of-the-day buckets for the dashboard donut (§2.3).
   * For each child with ≥1 event in the half-open instant window
   * [dayStartIso, dayEndExclusiveIso) (the Asia/Almaty calendar day for the
   * target date, computed UTC-side by the service per §1.3), take the latest
   * event and bucket it:
   *   - inKindergarten = last event is `check_in`
   *   - checkedOut     = last event is `check_out`
   * Optional `groupId` filters via `children.current_group_id`
   * (attendance_events has no group_id). Default stub so older in-memory
   * test fakes compile; the relational impl overrides with a DISTINCT ON
   * last-event query.
   */
  lastEventBucketsForDate(
    _kindergartenId: string,
    _dayStartIso: string,
    _dayEndExclusiveIso: string,
    _groupId?: string,
  ): Promise<{ inKindergarten: number; checkedOut: number }> {
    return Promise.resolve({ inKindergarten: 0, checkedOut: 0 });
  }
}
