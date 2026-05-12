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
  // ── B5/P5 — guardian lifecycle events emitted by ChildService but
  // previously absent from CANONICAL → users could not opt out via
  // PATCH /notifications/preferences (DTO IsIn rejected them) and
  // default-merge skipped them. Producers are
  // OutboxNotificationAdapter.notifyChildGuardian* / notifyChildTransferred.
  'guardian.pending_approval',
  'guardian.rejected',
  'guardian.revoked',
  'guardian.permissions_updated',
  'child.transferred',
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
  // ── B13 Billing & Invoices lifecycle events ───────────────────────────
  'invoice.created',
  'invoice.paid',
  'invoice.overdue',
  'invoice.cancelled',
  'payment.completed',
  'payment.failed',
  'payment.refunded',
  'refund.processed',
  // ── B13 / T11 H6 — admin-visible signal when first-invoice generation
  // skipped on enrollment.card_created because no tariff_assignment was
  // configured. Enables admins to remediate without monitoring server logs.
  'enrollment.first_invoice_skipped',
  // ── B21 Child lifecycle — admin archive / reactivate. Recipients are
  // approved-active guardians (parents only; nannies excluded by the
  // policy gate). `child.transferred` already lives above; these complete
  // the lifecycle triplet.
  'child.archived',
  'child.reactivated',
] as const;

export type EventKey = (typeof CANONICAL_EVENT_KEYS)[number];
