import { ConflictError } from '@/shared-kernel/domain/errors/conflict.error';

/**
 * Attempted to transfer an archived child between groups.
 *
 * Archived children are inactive — they no longer belong to a group from
 * a business standpoint, so a transfer would emit `child.transferred`
 * notifications to (likely revoked) guardians and add misleading rows to
 * `child_group_history`. Surfaced by `Child.transferToGroup()`; mapped to
 * HTTP 409 by `DomainErrorFilter`. The caller must reactivate the child
 * first (`POST /admin/children/:id/reactivate`) before re-attempting the
 * transfer.
 */
export class ArchivedChildNotTransferableError extends ConflictError {
  constructor(public readonly childId: string) {
    super(
      'archived_child_not_transferable',
      `child ${childId} is archived; reactivate before transferring between groups`,
    );
  }
}
