import { ForbiddenActionError } from '@/shared-kernel/domain/errors';

/**
 * 403 — non-admin staff tried to PATCH an attendance_event whose
 * `recorded_at` falls outside the same calendar day as `clock.now()`.
 *
 * Window is hard-coded to "same calendar day in Asia/Almaty" for B8.
 * TODO(B22): make the window configurable per kindergarten settings.
 */
export class AttendanceEditWindowExpiredError extends ForbiddenActionError {
  constructor(
    public readonly eventId: string,
    public readonly recordedAt: Date,
    public readonly now: Date,
  ) {
    super(
      'attendance_edit_window_expired',
      `attendance_event ${eventId} (recorded ${recordedAt.toISOString()}) is outside the non-admin edit window at ${now.toISOString()}`,
    );
  }
}
