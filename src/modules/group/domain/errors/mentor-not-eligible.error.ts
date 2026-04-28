import { DomainError } from '@/shared-kernel/domain/errors';

/**
 * Raised when assignMentor is called with a staff_member that is not in this
 * kindergarten, is not active, or is archived. The DB would also reject the
 * insert via the FK + RLS, but raising a domain error early gives the client
 * a stable code (`mentor_not_eligible`) instead of a 500.
 */
export class MentorNotEligibleError extends DomainError {
  constructor(staffMemberId: string) {
    super(
      'mentor_not_eligible',
      `staff_member ${staffMemberId} is not eligible to be a group mentor (must be active and belong to the same kindergarten)`,
    );
  }
}
