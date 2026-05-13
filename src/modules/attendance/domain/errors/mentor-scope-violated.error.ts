import { ForbiddenActionError } from '@/shared-kernel/domain/errors';

/**
 * 403 — a staff member with role `mentor` attempted a timeline write for a
 * child whose `current_group_id` does not match any group the caller is
 * actively assigned to mentor.
 *
 * Enforced by `TimelineService.createEntry / updateEntry / deleteEntry` for
 * non-admin callers with role=mentor. Admin and specialist/reception callers
 * bypass this check.
 */
export class MentorScopeViolatedError extends ForbiddenActionError {
  constructor(public readonly childId: string) {
    super(
      'mentor_scope_violated',
      `caller is not the active mentor for the group of child ${childId}`,
    );
  }
}
