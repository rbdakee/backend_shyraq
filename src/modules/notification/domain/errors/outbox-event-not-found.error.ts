import { NotFoundError } from '@/shared-kernel/domain/errors';

/**
 * 404 — the notification_outbox row does not exist (or RLS hides it).
 *
 * Outbox is an internal mechanism, so this error usually surfaces only in
 * tests or admin tooling. The stable `code` mirrors the convention from
 * other module-specific not-found errors.
 */
export class OutboxEventNotFoundError extends NotFoundError {
  public readonly code = 'outbox_event_not_found' as const;

  constructor(public readonly eventId: string) {
    super('outbox_event', eventId);
  }
}
