import { ConflictError } from '@/shared-kernel/domain/errors';

/**
 * The caller already has an APPROVED guardian row for this child — link is a
 * no-op and the request must be rejected so the UI can route to the existing
 * profile instead of duplicating intent. Mapped to HTTP 409.
 *
 * Distinct from `AlreadyPendingForChildError`: this error means the link is
 * fully active, while pending means the caller is still awaiting primary's
 * approval.
 */
export class AlreadyLinkedToChildError extends ConflictError {
  constructor(
    public readonly childId: string,
    public readonly userId: string,
  ) {
    super(
      'already_linked_to_child',
      `user=${userId} is already an approved guardian of child=${childId}`,
    );
  }
}
