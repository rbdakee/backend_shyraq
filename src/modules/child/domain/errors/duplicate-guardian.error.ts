import { DomainError } from '@/shared-kernel/domain/errors';

/**
 * Conflict on (child_id, user_id) pair — same user cannot be linked to the
 * same child twice. Mapped to HTTP 409.
 */
export class DuplicateGuardianError extends DomainError {
  constructor(
    public readonly childId: string,
    public readonly userId: string,
  ) {
    super(
      'guardian_already_exists',
      `guardian already exists for child=${childId}, user=${userId}`,
    );
  }
}
