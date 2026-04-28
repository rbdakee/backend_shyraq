import { DomainError } from '@/shared-kernel/domain/errors';

/**
 * Profile-level invariant violation (empty name, future DOB, invalid group
 * UUID). Mapped to HTTP 422.
 */
export class InvalidChildProfileError extends DomainError {
  constructor(public readonly field: string) {
    super('invalid_child_profile', `invalid child profile: field=${field}`);
  }
}
