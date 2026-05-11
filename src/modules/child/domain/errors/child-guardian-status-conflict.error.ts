import { ConflictError } from '@/shared-kernel/domain/errors/conflict.error';

/**
 * Thrown when a guardian state transition (approve/reject/revoke) loses a
 * race against a concurrent transition on the same row. The conditional
 * UPDATE WHERE status = :expected matched 0 rows, meaning another caller
 * already flipped the status between our findById read and the UPDATE.
 *
 * Maps to HTTP 409 via DomainErrorFilter.
 *
 * Closes FINDINGS.md SM2 — previously the unconditional `repo.update()`
 * silently overwrote concurrent transitions (last writer wins), so a
 * concurrent approve+reject pair could both succeed with HTTP 200.
 */
export class ChildGuardianStatusConflictError extends ConflictError {
  constructor(
    readonly guardianId: string,
    readonly expectedStatus: string,
  ) {
    super(
      'child_guardian_status_conflict',
      `guardian ${guardianId} status changed by another caller (expected ${expectedStatus})`,
    );
  }
}
