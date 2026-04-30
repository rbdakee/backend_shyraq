import { ForbiddenActionError } from '@/shared-kernel/domain/errors';

/**
 * 403 — the requested `pickupUserId` is not an approved active pickup
 * guardian of the child. Possible causes:
 *
 *   - no `child_guardians` row at all for (child, user)
 *   - row exists but `status != 'approved'`
 *   - row is approved but `revoked_at IS NOT NULL`
 *   - row is approved but `can_pickup = false`
 *
 * Service.ts collapses all four into this single error so the API doesn't
 * leak the precise reason (a non-pickup parent must not learn whether their
 * link exists at all in another kindergarten, etc.).
 */
export class PickupUserNotAllowedError extends ForbiddenActionError {
  constructor(
    public readonly childId: string,
    public readonly userId: string,
  ) {
    super(
      'pickup_user_not_allowed',
      `user ${userId} is not allowed to pick up child ${childId}`,
    );
  }
}
