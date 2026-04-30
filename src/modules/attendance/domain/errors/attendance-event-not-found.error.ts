import { NotFoundError } from '@/shared-kernel/domain/errors';

/**
 * 404 — the attendance_events row does not exist (or RLS hides it). The
 * stable `code` is module-specific so API clients can disambiguate from
 * generic `not_found`.
 */
export class AttendanceEventNotFoundError extends NotFoundError {
  public readonly code = 'attendance_event_not_found' as const;

  constructor(public readonly eventId: string) {
    super('attendance_event', eventId);
  }
}
