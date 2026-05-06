/**
 * Canonical set of notification event keys for the Shyraq platform (B9).
 *
 * Used by:
 *  - `PATCH /notifications/preferences` DTO validation (`IsIn`)
 *  - `GET /notifications/preferences` default-merging logic
 *  - `NotificationDispatcher` template resolver
 *
 * Add a new key here whenever a new notification type is introduced.
 * Removing a key is a breaking change (clients may have stored preferences
 * for it) — deprecate with a comment instead.
 */
export const CANONICAL_EVENT_KEYS = [
  'attendance.checkin',
  'attendance.checkout',
  'daily_status.changed',
  'timeline.entry_created',
  'guardian.approved',
  'guardian.self_revoked',
  'payment.upcoming',
  'payment.overdue',
  'payment.receipt_issued',
  'diagnostic.new',
  'progress_note.new',
  'pickup.otp_sent',
  'pickup.validated',
  'content.news_published',
  'content.story_new',
  'content.qundylyq_new',
  'content.birthday',
  'discount.activated',
  'request.reviewed',
  'request.message_replied',
  // ── B12 Parent-request lifecycle events ───────────────────────────────
  'request.accepted',
  'request.rejected',
  'request.cancelled',
  'request.message_sent',
  'face.enrolled',
  'fiscal.retry_failed',
] as const;

export type EventKey = (typeof CANONICAL_EVENT_KEYS)[number];
