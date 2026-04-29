import { ConflictError } from '@/shared-kernel/domain/errors';

/**
 * Raised when `transitionTo(card_created, ...)` is called on an enrollment
 * whose `childId` is already set — i.e. a child card has already been
 * materialised from this lead. Mapped to HTTP 409.
 */
export class EnrollmentAlreadyConvertedError extends ConflictError {
  constructor(
    public readonly enrollmentId: string,
    public readonly childId: string,
  ) {
    super(
      'enrollment_already_converted',
      `enrollment ${enrollmentId} already converted to child ${childId}`,
    );
  }
}
