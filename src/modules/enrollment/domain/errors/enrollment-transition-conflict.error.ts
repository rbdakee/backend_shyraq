import { ConflictError } from '@/shared-kernel/domain/errors';
import { EnrollmentStatusValue } from '../value-objects/enrollment-status.vo';

/**
 * Lost-update race on enrollment status transition.
 *
 * Surfaced when the conditional UPDATE on `enrollments`
 * (`WHERE status = <expected_old>`) affects 0 rows: another concurrent
 * request already moved the enrollment to a different status between our
 * read-validate and our write. The current request loses the race; the
 * response is HTTP 409 so the client can re-fetch + retry.
 *
 * Critical for the `card_created` edge: that transition also creates a
 * `children` row + a `child_guardians` row. If two concurrent transitions
 * both pass the in-memory state check, both create children, and both write
 * `status='card_created'` (last-write-wins), the loser's child becomes an
 * orphan (the enrollment.assigned_child_id only points at the winner). The
 * conditional UPDATE forces the loser to 0 rows affected → throw this error
 * → ambient TX rollback → loser's child + guardian rows are never persisted.
 */
export class EnrollmentTransitionConflictError extends ConflictError {
  public readonly code = 'enrollment_transition_conflict' as const;

  constructor(
    public readonly enrollmentId: string,
    public readonly expectedFrom: EnrollmentStatusValue,
    public readonly attemptedTo: EnrollmentStatusValue,
  ) {
    super(
      'enrollment_transition_conflict',
      `enrollment ${enrollmentId} status changed concurrently: expected ${expectedFrom} when transitioning to ${attemptedTo}`,
    );
  }
}
