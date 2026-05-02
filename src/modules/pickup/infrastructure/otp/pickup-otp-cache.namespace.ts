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
 * The OTP code itself, stored as a plain string entry. TTL =
 * expires_at - now at insert time so the entry self-evicts when the
 * pickup_request deadline passes. T7 fix M6: previously this key held a
 * hash containing both the code and the attempts counter; the counter
 * has been moved to a standalone key so that TTL eviction of the code
 * entry does not also reset the failed-attempt budget.
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
 * code entry (e.g. when TTL expires mid-attempt). T7 split this back
 * out from the inline hash shape to close a counter-reset hole.
 */
export function pickupOtpAttemptsRedisKey(requestId: string): string {
  return `${ROOT}:attempts:${requestId}`;
}
