import { DomainError } from '@/shared-kernel/domain/errors';

/**
 * 400 — caller supplied an `event_key` that is not in
 * `CANONICAL_EVENT_KEYS`. Returned by
 * `PATCH /notifications/preferences` when the body contains an
 * unknown key.
 */
export class InvalidEventKeyError extends DomainError {
  public readonly code = 'invalid_event_key' as const;

  constructor(public readonly eventKey: string) {
    super('invalid_event_key', `Unknown event key: ${eventKey}`);
  }
}
