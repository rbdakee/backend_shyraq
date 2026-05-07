import { ConflictError } from '@/shared-kernel/domain/errors';

/**
 * 409 — state-machine guard violation: the caller asked the CustomDiscount
 * aggregate to perform a transition (`activate`, `pause`, `resume`,
 * `cancel`, `markExpired`) that is not legal from its current status.
 *
 * `currentStatus` / `attemptedTransition` give clients enough context to
 * render an actionable message.
 */
export class CustomDiscountStatusInvalidError extends ConflictError {
  public readonly code = 'custom_discount_status_invalid' as const;
  public readonly details: {
    currentStatus: string;
    attemptedTransition: string;
  };

  constructor(currentStatus: string, attemptedTransition: string) {
    super(
      'custom_discount_status_invalid',
      `custom discount status invalid: transition=${attemptedTransition} got=${currentStatus}`,
    );
    this.details = { currentStatus, attemptedTransition };
  }
}
