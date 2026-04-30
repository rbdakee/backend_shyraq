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
}
