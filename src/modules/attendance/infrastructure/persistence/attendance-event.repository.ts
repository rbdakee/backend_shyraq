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
 * Port over `attendance_events`. Append-only — no `delete` method exposed.
 * Updates are limited to recorded_at / notes / pickup_user_id via the
 * domain entity's `applyPatch`.
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
}
