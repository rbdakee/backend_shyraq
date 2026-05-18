import { DomainError } from '@/shared-kernel/domain/errors';

/**
 * Raised when a staff_members row with role='admin' already exists for the
 * given (kindergarten_id, user_id) pair — regardless of its is_active flag.
 * Distinct from StaffAlreadyExistsError (non-admin staff row collision).
 * Maps to HTTP 409 Conflict.
 */
export class AdminAlreadyExistsError extends DomainError {
  constructor(kindergartenId: string, userId: string) {
    super(
      'admin_already_exists',
      `admin already exists for kg=${kindergartenId} user=${userId}`,
    );
  }
}
