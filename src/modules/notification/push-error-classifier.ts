/**
 * Push-error classifier.
 *
 * `NotificationDispatcher` calls `PushNotificationPort.send(...)` per token.
 * When the underlying transport (FCM, APNS, web-push) rejects the call we
 * have to decide whether to:
 *
 *   - delete the token + continue with the rest of the dispatch, OR
 *   - mark the entire outbox event `failed` so the worker re-tries it.
 *
 * The decision hinges on what kind of error came back. FCM and APNS return
 * a small set of well-known strings for "this device is gone, never retry".
 * Anything else (5xx, transport timeout, generic Error) is transient and the
 * event must be re-tried so transient outages do not silently lose pushes.
 *
 * Pure function — no I/O, no logger, deterministic. Lives outside the
 * dispatcher class so it can be unit-tested in isolation.
 */

export type PushErrorClassification = 'permanent_token' | 'transient';

/**
 * Substrings emitted by the push-provider SDKs / REST APIs that indicate the
 * device-token is permanently dead. Match-once, case-insensitive, against the
 * error's `code`/`message`. Source:
 *   - FCM legacy: `InvalidRegistration`, `NotRegistered`, `MismatchSenderId`.
 *   - FCM v1   : `messaging/registration-token-not-registered`,
 *                `messaging/invalid-registration-token`,
 *                `UNREGISTERED`.
 *   - APNS     : `BadDeviceToken`, `Unregistered`, `DeviceTokenNotForTopic`.
 *
 * Conservative on purpose: only patterns that unambiguously mean "drop the
 * token" land here. Anything ambiguous (`InternalServerError`, `Unavailable`,
 * `QuotaExceeded`, …) stays transient — the outbox will retry with backoff
 * and surface the real failure if it keeps happening past `MAX_OUTBOX_ATTEMPTS`.
 */
const PERMANENT_TOKEN_PATTERNS: readonly RegExp[] = [
  /InvalidRegistration/i,
  /NotRegistered/i,
  /BadDeviceToken/i,
  /Unregistered/i,
  /MismatchSenderId/i,
  /registration-token-not-registered/i,
  /invalid-registration-token/i,
  /DeviceTokenNotForTopic/i,
];

/**
 * Classify a thrown value from `PushNotificationPort.send`. Inspects:
 *   - `err.code` (string) — preferred field for FCM/APNS-style errors.
 *   - `err.message` — fallback when the SDK only sets the message.
 *   - `String(err)` — last-resort coercion for non-Error throws.
 *
 * Anything that does not match a permanent-token pattern is `transient`.
 */
export function classifyPushError(err: unknown): PushErrorClassification {
  const haystack = errorToHaystack(err);
  for (const re of PERMANENT_TOKEN_PATTERNS) {
    if (re.test(haystack)) return 'permanent_token';
  }
  return 'transient';
}

function errorToHaystack(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    const codeStr = typeof code === 'string' ? code : '';
    return `${codeStr} ${err.message}`;
  }
  if (err === null || err === undefined) return '';
  return String(err);
}
