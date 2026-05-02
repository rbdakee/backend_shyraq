import { ConflictError } from '@/shared-kernel/domain/errors';

/**
 * 409 — generic state-machine guard violation: the caller asked the
 * aggregate to perform a transition that is not legal from its current
 * status. Common cases handled by more specific errors when possible
 * (`PickupRequestAlreadyValidatedError`, `PickupRequestExpiredError`);
 * everything else (e.g. validate-on-cancelled, expire-on-validated) lands
 * here.
 *
 * `details.currentStatus` / `details.expectedStatus` give clients enough
 * context to render an actionable message without parsing the message
 * string. Typed as `string` to avoid an entity ↔ errors import cycle —
 * callers in this module already know the literal union is
 * `'otp_sent' | 'validated' | 'expired' | 'cancelled'`.
 */
export class PickupRequestStatusInvalidError extends ConflictError {
  public readonly code = 'pickup_request_status_invalid' as const;
  public readonly details: {
    currentStatus: string;
    expectedStatus: string;
    attemptedAction: string;
  };

  constructor(
    currentStatus: string,
    expectedStatus: string,
    attemptedAction: string,
  ) {
    super(
      'pickup_request_status_invalid',
      `pickup request status invalid: action=${attemptedAction} expected=${expectedStatus} got=${currentStatus}`,
    );
    this.details = { currentStatus, expectedStatus, attemptedAction };
  }
}
