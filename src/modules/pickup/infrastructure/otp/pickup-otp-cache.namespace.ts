/**
 * Centralised key-builders for the B11 pickup OTP store. The pickup flow
 * does NOT reuse `OtpStorePort` (which keys on `phone`) because pickup
 * OTPs are scoped to a single `pickup_request.id` — multiple parents in
 * the same kindergarten can independently request pickup for different
 * children using the same trusted-person phone, and we must isolate their
 * OTPs.
 *
 * The key namespace is `otp:pickup:{requestId}` so it cannot collide with
 * the `otp:{phone}` and `otp:lock:{phone}` keys owned by the auth module.
 *
 * T4 will pick the actual storage primitive — most likely a thin
 * `PickupOtpStorePort` adapter that wraps `RedisService` directly with
 * these key prefixes. This file only owns the prefix string so all future
 * keys live in one place.
 */

const ROOT = 'otp:pickup' as const;

/**
 * The OTP code itself, stored alongside attempt count. TTL = expires_at -
 * now at insert time so the entry self-evicts when the pickup_request
 * deadline passes.
 */
export function pickupOtpRedisKey(requestId: string): string {
  return `${ROOT}:${requestId}`;
}

/**
 * Per-request rate-limit / lock key — set after N failed validate
 * attempts, similar to `otp:lock:{phone}` in auth.
 */
export function pickupOtpLockRedisKey(requestId: string): string {
  return `${ROOT}:lock:${requestId}`;
}

/**
 * Per-request attempt counter — increments on each failed `validate-otp`.
 * Separate from the OTP value entry so the counter outlives an evicted
 * code entry (e.g. when TTL expires mid-attempt). T4 may inline this into
 * the same hash as the code; both shapes work.
 */
export function pickupOtpAttemptsRedisKey(requestId: string): string {
  return `${ROOT}:attempts:${requestId}`;
}
