import {
  EnrollmentStatusLogEntry,
  EnrollmentStatusLogEntryDraft,
} from '../../domain/types/enrollment-status-log-entry';

/**
 * Port over `enrollment_status_log`. Append-only — no update/delete methods
 * exist on purpose. `listForEnrollment` returns rows newest-first (matches
 * the `idx_enrollment_log_enrollment` index direction).
 */
export abstract class EnrollmentStatusLogRepository {
  abstract append(
    kindergartenId: string,
    draft: EnrollmentStatusLogEntryDraft,
  ): Promise<EnrollmentStatusLogEntry>;

  abstract listForEnrollment(
    kindergartenId: string,
    enrollmentId: string,
  ): Promise<EnrollmentStatusLogEntry[]>;
}
