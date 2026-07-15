import { ForbiddenActionError } from '@/shared-kernel/domain/errors';

/**
 * 403 — a non-admin caller tried to change `child_id` or `event_type` on an
 * attendance_event.
 *
 * Those two fields are corrections of a mis-filed record rather than ordinary
 * edits: they move the event onto a different child or flip its direction,
 * which cascades into `child_daily_status` and the parent-visible timeline.
 * Reception keeps the narrow recorded_at / notes / pickup_user_id patch;
 * anything structural is admin-only and journalled to `audit_log`.
 *
 * Who actually hits this: `reception`. It reaches
 * `PATCH /admin/attendance-events/:eventId` through the controller's
 * class-level `@Roles('admin','reception')` and binds
 * `AdminPatchAttendanceDto`, which DOES declare both fields — so the request
 * is well-formed and only the role check stops it
 * (`allowStructuralCorrection: user.role === 'admin'`).
 *
 * Staff on `/staff/attendance/:eventId` never get here: that route binds
 * `PatchAttendanceDto`, which declares neither field, and the global
 * ValidationPipe runs `whitelist: true`, so the fields are stripped before
 * the service is called. The guard still runs for them as defence in depth.
 */
export class AttendanceCorrectionAdminOnlyError extends ForbiddenActionError {
  constructor(
    public readonly eventId: string,
    public readonly field: 'child_id' | 'event_type',
  ) {
    super(
      'attendance_correction_admin_only',
      `changing ${field} on attendance_event ${eventId} requires the admin role`,
    );
  }
}
