import { DomainError } from '@/shared-kernel/domain/errors';

/**
 * 422 — `recorded_at` (attendance event) or `entry_time` (timeline entry)
 * is in the future relative to the server clock (with a 5-minute skew
 * tolerance). Maps to HTTP 422 via the explicit branch in
 * `DomainErrorFilter`. Code `invalid_attendance_timestamp`.
 *
 * Used by AttendanceService.checkIn / checkOut / patchEvent and by
 * TimelineService.createEntry / updateEntry. T6 M3 fix-pass.
 */
export class InvalidAttendanceTimestampError extends DomainError {
  constructor(when: Date, now: Date) {
    super(
      'invalid_attendance_timestamp',
      `recorded_at ${when.toISOString()} is in the future (server clock ${now.toISOString()})`,
    );
  }
}
