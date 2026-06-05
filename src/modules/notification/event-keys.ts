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
 *
 * ─────────────────────────────────────────────────────────────────────────
 * B22a SP7 — 7 stale keys removed (2026-05-13):
 *   payment.upcoming, payment.overdue, payment.receipt_issued,
 *   request.reviewed, request.message_replied,
 *   face.enrolled, fiscal.retry_failed
 * Reason: no producer / template / resolver backed them, so a future
 * accidental emit would silently fail in the dispatcher (latent bug). They
 * will be re-introduced by their owning batches when the matching producer
 * + template land:
 *   - payment.upcoming / payment.overdue / payment.receipt_issued → B14
 *     (real payment-provider integration adds dunning + receipts)
 *   - request.reviewed / request.message_replied → B15
 *     (parent-request review queue + threaded reply notifications)
 *   - face.enrolled → B19 (face-enrollment confirmation)
 *   - fiscal.retry_failed → B14 (OFD/fiscal-receipt retry escalation)
 * ─────────────────────────────────────────────────────────────────────────
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
  'diagnostic.new',
  'progress_note.new',
  'pickup.otp_sent',
  'pickup.validated',
  'content.news_published',
  'content.story_new',
  'content.qundylyq_new',
  'content.birthday',
  'discount.activated',
  // ── B12 Parent-request lifecycle events ───────────────────────────────
  'request.accepted',
  'request.rejected',
  'request.cancelled',
  'request.message_sent',
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
  // ── B24 Kaspi Pay — admin-facing alert when the cashier session expires
  // and the silent SignInLite refresh fails (K8 poller). Recipients are kg
  // admins (pre-resolved into the payload by the producer).
  'kaspi.session_expired',
] as const;

export type EventKey = (typeof CANONICAL_EVENT_KEYS)[number];
