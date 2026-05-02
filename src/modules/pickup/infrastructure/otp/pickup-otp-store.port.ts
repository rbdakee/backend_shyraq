/**
 * `PickupOtpStorePort` — narrowed OTP store contract owned by the pickup
 * module. Keys diverge from auth's `OtpStorePort`: the code itself is keyed
 * by `pickup_request.id` (so two parents in the same kg can request pickup
 * for different children using the same trusted-person phone without
 * stepping on each other), while rate-limit + per-request lock are
 * narrower variants kept in this namespace too. Per-phone rate-limit is
 * still shared with the auth login flow (`rate:otp:{phone}`) so abusing
 * pickup OTP doesn't grant extra login budget — that one delegates to
 * `OtpStorePort` from auth.
 *
 * Implementations are Redis-backed; `pickup-otp-cache.namespace.ts` owns
 * the key prefixes.
 */
export interface StoredPickupOtp {
  code: string;
  attempts: number;
}

export abstract class PickupOtpStorePort {
  /**
   * Store the 6-digit code at `otp:pickup:{requestId}` with the given TTL.
   * Resets `attempts` to 0. Re-issuing on the same request id overwrites
   * (used for resend-otp). Returns the redis key for downstream
   * `pickup_requests.otp_ref` stamping.
   */
  abstract storeCode(
    requestId: string,
    code: string,
    ttlSec: number,
  ): Promise<string>;

  /** Reads the stored code. Null when expired / cleared. */
  abstract readCode(requestId: string): Promise<StoredPickupOtp | null>;

  /** Removes the code entry (post-success or post-cancel). */
  abstract clearCode(requestId: string): Promise<void>;

  /** Increments per-request failed-attempt counter. Returns new total. */
  abstract incrementAttempts(requestId: string): Promise<number>;

  /**
   * Lock for `lockTtlSec` seconds — used after N consecutive validation
   * failures to back off the request. Read with `isLocked`.
   */
  abstract lockRequest(requestId: string, lockTtlSec: number): Promise<void>;

  abstract isLocked(requestId: string): Promise<boolean>;
}
