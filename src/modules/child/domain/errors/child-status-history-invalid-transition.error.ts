import { InvariantViolationError } from '@/shared-kernel/domain/errors/invariant-violation.error';
import type { ChildStatusValue } from '../entities/child-status-history.entity';

/**
 * Thrown by `ChildStatusHistory.record(...)` when the supplied transition
 * is not in the whitelist (`active→archived`, `archived→active`,
 * `card_created→active`). Mirrors the DB CHECK `chk_valid_transition` so
 * an HTTP caller sees a typed 422 instead of a raw 500 from a generic
 * `Error` slipping past `DomainErrorFilter`. T13 M1 (opus) follow-up.
 */
export class ChildStatusHistoryInvalidTransitionError extends InvariantViolationError {
  constructor(
    public readonly previousStatus: ChildStatusValue,
    public readonly newStatus: ChildStatusValue,
  ) {
    super('child_status_history_invalid_transition');
  }
}
