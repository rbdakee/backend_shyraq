import { DomainError } from '@/shared-kernel/domain/errors';

/**
 * 422 — caller tried to create a timeline_entry with entry_type='check_in' or
 * 'check_out'. Those rows are written automatically by AttendanceService.
 * Staff-facing timeline endpoints only allow the manual entry types.
 */
export class InvalidTimelineEntryTypeError extends DomainError {
  constructor(public readonly entryType: string) {
    super(
      'invalid_timeline_entry_type',
      `entry_type '${entryType}' cannot be created manually — check_in and check_out rows are written automatically by the attendance flow`,
    );
  }
}
