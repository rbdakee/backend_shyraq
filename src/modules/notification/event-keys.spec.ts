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
});
