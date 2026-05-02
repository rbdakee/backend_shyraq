import { ConflictError } from '@/shared-kernel/domain/errors';

/**
 * 409 — staff submitted a valid OTP for a pickup_request that is already
 * in terminal state `validated`. This is a "double check-out" attempt
 * (network retry, two staff with the same screen, etc.). Distinct from
 * `pickup_request_status_invalid` because the validated state is a
 * concrete success-with-recipient case the client should surface as
 * "already picked up" rather than a generic state mismatch.
 */
export class PickupRequestAlreadyValidatedError extends ConflictError {
  public readonly code = 'pickup_request_already_validated' as const;

  constructor() {
    super(
      'pickup_request_already_validated',
      'pickup request has already been validated',
    );
  }
}
