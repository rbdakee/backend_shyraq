/**
 * `ParentRequestOtpStorePort` — OTP cache contract for the B12 trusted_person
 * sub-flow. Mirrors `PickupOtpStorePort` (B11) — keyed by the `requesterUserId`
 * (the parent who initiated /otp-request) under namespace
 * `otp:request:trusted-person:{userId}` so two parents in the same kg can run
 * separate flows concurrently. Per-phone rate-limit is shared with auth's
 * `OtpStorePort.checkRateLimit` so abusing this endpoint does not earn extra
 * login OTP budget.
 *
 * The port is intentionally narrow: storeCode (with returned namespace key),
 * consumeCode (atomic verify-and-clear), and the lock/attempts machinery so
 * brute-force attempts get backed off on the same window the auth flow uses.
 */
export interface StoredParentRequestOtp {
  code: string;
  attempts: number;
}

export abstract class ParentRequestOtpStorePort {
  /**
   * Store the 6-digit code at `otp:request:trusted-person:{userId}` with the
   * given TTL. Resets `attempts` to 0. Returns the redis key for downstream
   * `otp_ref` surfaces (NOT the code itself).
   */
  abstract storeCode(
    userId: string,
    code: string,
    ttlSec: number,
  ): Promise<string>;

  /** Reads the stored code. Null when expired / cleared. */
  abstract readCode(userId: string): Promise<StoredParentRequestOtp | null>;

  /** Removes the code entry (post-success or post-cancel). */
  abstract clearCode(userId: string): Promise<void>;

  /** Increments per-user failed-attempt counter. Returns new total. */
  abstract incrementAttempts(userId: string): Promise<number>;

  /**
   * Lock for `lockTtlSec` seconds — used after N consecutive validation
   * failures to back off the user. Read with `isLocked`.
   */
  abstract lockUser(userId: string, lockTtlSec: number): Promise<void>;

  abstract isLocked(userId: string): Promise<boolean>;
}
