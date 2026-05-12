import { ConflictError } from '@/shared-kernel/domain/errors/conflict.error';

/**
 * Reactivate attempt against a child that is not currently in the `archived`
 * status. Strict state machine: only `archived` → `active` is permitted via
 * `Child.reactivate()`. Mapped to HTTP 409.
 */
export class ChildNotArchivedError extends ConflictError {
  constructor(public readonly childId: string) {
    super(
      'child_not_archived',
      `child ${childId} is not archived and cannot be reactivated`,
    );
  }
}
