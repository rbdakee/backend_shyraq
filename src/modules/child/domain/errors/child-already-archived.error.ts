import { ConflictError } from '@/shared-kernel/domain/errors/conflict.error';

/**
 * Archive attempt against a child that is already in the `archived` status.
 *
 * Surfaced by `Child.archive()` (strict state machine: only `active` →
 * `archived` is permitted) and re-asserted by the repository's conditional
 * UPDATE on `WHERE status = 'active'`. Mapped to HTTP 409 — the caller's
 * intent is no-op; the UI should refresh and disable the archive button.
 */
export class ChildAlreadyArchivedError extends ConflictError {
  constructor(public readonly childId: string) {
    super('child_already_archived', `child ${childId} is already archived`);
  }
}
