import { ForbiddenActionError } from '@/shared-kernel/domain/errors';

/**
 * 403 — a trusted_people row exists but its `child_id` does not match the
 * child the caller is requesting pickup for. Distinct from 404 because the
 * row is real; distinct from 401/RLS because the row is in the same
 * tenant. The caller is attempting to use someone else's trusted-person
 * record on their own child.
 */
export class TrustedPersonNotForChildError extends ForbiddenActionError {
  public readonly code = 'trusted_person_not_for_child' as const;

  constructor() {
    super(
      'trusted_person_not_for_child',
      'trusted person is not registered for this child',
    );
  }
}
