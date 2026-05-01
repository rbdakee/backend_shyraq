/**
 * PushNotificationPort — fan-out sink for push notifications.
 *
 * Each call delivers a single payload to every device-token registered for a
 * single user. The dispatcher (T4) is responsible for:
 *   - resolving the user list (recipient resolution + preferences filter),
 *   - loading each user's tokens (`PushTokenRepository.findByUserIds`),
 *   - calling `send()` once per user.
 *
 * Per-token failures (invalid token, transport error) are the adapter's
 * concern. The dispatcher wraps each `send()` in try/catch — one user's
 * push failure must NOT fail the whole outbox-event dispatch.
 *
 * B22 will replace the FCM stub with real `firebase-admin`-backed delivery.
 */

export interface PushDeviceToken {
  /** Row id from `push_tokens` — useful for the adapter to delete dead tokens. */
  id: string;
  platform: 'ios' | 'android' | 'web';
  /** Device-side opaque token string (FCM/APNS token). */
  token: string;
}

export interface PushTarget {
  userId: string;
  tokens: PushDeviceToken[];
}

export interface PushPayload {
  title: string;
  body: string;
  /**
   * FCM `data` payload. Per FCM contract values must be strings — the
   * dispatcher serialises any non-string field before constructing the
   * payload.
   */
  data?: Record<string, string>;
}

export abstract class PushNotificationPort {
  abstract send(target: PushTarget, payload: PushPayload): Promise<void>;
}
