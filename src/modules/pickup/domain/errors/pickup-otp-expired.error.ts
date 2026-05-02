import { GoneError } from '@/shared-kernel/domain/errors';

/**
 * 410 Gone — the Redis OTP entry for a `pickup_request` is missing or
 * has been TTL-evicted. Distinct from `PickupRequestExpiredError`
 * (the request row itself outlived `expires_at`) and from auth's
 * `OtpExpiredError` (login OTP, 400) — pickup keeps its own 410-mapped
 * domain error so the API contract stays "the OTP code is gone, ask
 * the trusted person to call /send-otp again on a fresh request".
 *
 * Code is `otp_expired` to match docs/endpoints.md §3.6 error map.
 */
export class PickupOtpExpiredError extends GoneError {
  public readonly code = 'otp_expired' as const;

  constructor() {
    super('otp_expired', 'pickup OTP has expired or is missing');
  }
}
