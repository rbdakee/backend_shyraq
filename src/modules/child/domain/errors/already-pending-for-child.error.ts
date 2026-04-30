import { ConflictError } from '@/shared-kernel/domain/errors';

/**
 * The caller already has a PENDING_APPROVAL guardian row for this child —
 * the previous link request is still awaiting primary's decision. The UI
 * should surface the pending state and offer a withdrawal path rather than
 * letting the user spam new requests. Mapped to HTTP 409.
 */
export class AlreadyPendingForChildError extends ConflictError {
  constructor(
    public readonly childId: string,
    public readonly userId: string,
  ) {
    super(
      'already_pending_for_child',
      `user=${userId} already has a pending guardian request for child=${childId}`,
    );
  }
}
