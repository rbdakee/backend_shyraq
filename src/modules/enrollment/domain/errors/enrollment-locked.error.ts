import { ConflictError } from '@/shared-kernel/domain/errors';
import { EnrollmentStatusValue } from '../value-objects/enrollment-status.vo';

/**
 * Raised by mutation methods (`update`, `assignTo`) when the enrollment is in
 * a status that locks edits — `card_created`, `cancelled`, or `archive`.
 * Mapped to HTTP 409.
 */
export class EnrollmentLockedError extends ConflictError {
  constructor(public readonly currentStatus: EnrollmentStatusValue) {
    super(
      'enrollment_locked',
      `enrollment is locked for edits in status: ${currentStatus}`,
    );
  }
}
