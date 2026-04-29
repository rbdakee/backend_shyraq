import { EnrollmentStatusValue } from '../value-objects/enrollment-status.vo';

/**
 * Append-only audit-log row for an enrollment status change.
 *
 * `id` is owned by the persistence layer (DB DEFAULT gen_random_uuid()), but
 * the typed shape carries it as required because consumers read fully-persisted
 * rows. `fromStatus` is `null` for the implicit creation transition (no prior
 * state) — but is otherwise the previous status. `changedBy` is a
 * `staff_members.id` UUID.
 */
export interface EnrollmentStatusLogEntry {
  id: string;
  enrollmentId: string;
  kindergartenId: string;
  fromStatus: EnrollmentStatusValue | null;
  toStatus: EnrollmentStatusValue;
  changedBy: string;
  comment: string | null;
  createdAt: Date;
}

/**
 * Pre-persistence form returned by `Enrollment.transitionTo()`. The repository
 * fills in the `id` when inserting the row.
 */
export type EnrollmentStatusLogEntryDraft = Omit<
  EnrollmentStatusLogEntry,
  'id'
>;
