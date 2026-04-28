import { DomainError } from '@/shared-kernel/domain/errors';

/**
 * Raised when assigning a mentor to a group hits the partial-unique index
 * `idx_group_mentors_one_active`. The race is rare in practice — the
 * service closes the previous active row in the same TX before inserting,
 * so this error usually surfaces only when two admin requests interleave.
 */
export class MentorAlreadyActiveError extends DomainError {
  constructor(groupId: string) {
    super(
      'mentor_already_active',
      `group ${groupId} already has an active mentor`,
    );
  }
}
