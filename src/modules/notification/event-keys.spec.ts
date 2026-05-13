import { CANONICAL_EVENT_KEYS } from './event-keys';

describe('CANONICAL_EVENT_KEYS', () => {
  // Regression guard for FINDINGS.md SP6: 5 producer-emitted keys were
  // missing from CANONICAL — PATCH /notifications/preferences rejected them
  // and default-merge skipped them, so users could not opt out and the
  // dispatcher always fell back to push_enabled=true.
  it.each([
    'guardian.pending_approval',
    'guardian.rejected',
    'guardian.revoked',
    'guardian.permissions_updated',
    'child.transferred',
  ])('contains %s (producer-emitted via OutboxNotificationAdapter)', (key) => {
    expect(CANONICAL_EVENT_KEYS).toContain(key);
  });

  // B22a SP7 (FINDINGS.md): 7 keys had no producer/template/resolver. They
  // were removed to keep the canonical surface honest. They will be
  // re-introduced by the owning batch when a real producer + template land
  // (B14/B15/B19 — see header comment in event-keys.ts).
  it.each([
    'payment.upcoming',
    'payment.overdue',
    'payment.receipt_issued',
    'request.reviewed',
    'request.message_replied',
    'face.enrolled',
    'fiscal.retry_failed',
  ])('rejects stale key %s (B22a SP7 — re-add via owning batch)', (key) => {
    expect(CANONICAL_EVENT_KEYS).not.toContain(key);
  });
});
