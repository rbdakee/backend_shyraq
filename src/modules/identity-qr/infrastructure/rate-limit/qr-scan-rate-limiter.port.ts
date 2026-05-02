/**
 * Per-device rate limiter for `POST /staff/qr/scan`. Locked at 60 calls per
 * 60-second window per `device_id` (B10 §1).
 */
export abstract class QrScanRateLimiterPort {
  /**
   * Returns `{ ok: true }` when the call is within the budget, or
   * `{ ok: false, retryAfterSeconds }` when the device should back off.
   * `retryAfterSeconds` is the TTL on the current window — caller can
   * surface it via 429 `details.retryAfterSeconds`.
   */
  abstract check(deviceId: string): Promise<{
    ok: boolean;
    retryAfterSeconds: number | null;
  }>;
}
