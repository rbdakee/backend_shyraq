import { ConflictError } from '@/shared-kernel/domain/errors';
import { EnrollmentStatusValue } from '../value-objects/enrollment-status.vo';

/**
 * Disallowed status-machine edge (e.g. `archive → anything` or
 * `new → card_created`). Mapped to HTTP 409 by the domain-error filter.
 */
export class InvalidEnrollmentStatusTransitionError extends ConflictError {
  constructor(
    public readonly from: EnrollmentStatusValue,
    public readonly to: EnrollmentStatusValue,
  ) {
    super(
      'invalid_enrollment_status_transition',
      `cannot transition enrollment status: ${from} -> ${to}`,
    );
  }
}
