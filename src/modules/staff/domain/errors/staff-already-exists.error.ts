import { DomainError } from '@/shared-kernel/domain/errors';

/**
 * Raised when an active staff_members row already exists for the given
 * (kindergarten_id, user_id) pair. Maps to HTTP 409 Conflict.
 */
export class StaffAlreadyExistsError extends DomainError {
  constructor(kindergartenId: string, userId: string) {
    super(
      'staff_already_exists',
      `staff already exists for kg=${kindergartenId} user=${userId}`,
    );
  }
}
