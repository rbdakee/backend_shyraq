import { GoneError } from '@/shared-kernel/domain/errors';

/**
 * 410 Gone — a pickup_request resolved but its `expires_at` has passed
 * before staff could submit the OTP. The client should ask the parent to
 * re-issue (creating a new request) rather than retry the same id.
 *
 * Note: status flips to `expired` lazily — either by the staff-validate
 * code path checking `now >= expires_at` before transitioning, or by a
 * cleanup job in T6. Either way, scrubbing the row is a state-machine
 * step (`PickupRequest.expire`), not a hard delete.
 */
export class PickupRequestExpiredError extends GoneError {
  public readonly code = 'pickup_request_expired' as const;

  constructor() {
    super('pickup_request_expired', 'pickup request has expired');
  }
}
