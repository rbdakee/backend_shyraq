import { ConflictError } from '@/shared-kernel/domain/errors';

/**
 * 409 — state-machine guard violation: the caller asked the aggregate to
 * perform a transition (`accept`, `reject`, `cancel`) that is not legal
 * from its current status. Only legal source status is `pending` for all
 * three transitions.
 *
 * `currentStatus` / `attemptedAction` give clients enough context to render
 * an actionable message. Typed as `string` to avoid an entity ↔ errors
 * import cycle — callers already know the literal union is
 * `'pending' | 'accepted' | 'rejected' | 'cancelled'`.
 */
export class ParentRequestStatusInvalidError extends ConflictError {
  public readonly code = 'parent_request_status_invalid' as const;
  public readonly details: {
    currentStatus: string;
    attemptedAction: string;
  };

  constructor(currentStatus: string, attemptedAction: string) {
    super(
      'parent_request_status_invalid',
      `parent request status invalid: action=${attemptedAction} got=${currentStatus}`,
    );
    this.details = { currentStatus, attemptedAction };
  }
}
