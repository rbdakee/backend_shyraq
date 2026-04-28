import { DomainError } from '@/shared-kernel/domain/errors';

/**
 * Parent-side access guard rejection: the calling user is not an approved
 * guardian of the requested child. Mapped to HTTP 403.
 */
export class ChildAccessDeniedError extends DomainError {
  constructor(
    public readonly userId: string,
    public readonly childId: string,
  ) {
    super(
      'child_access_denied',
      `user=${userId} has no approved guardian record for child=${childId}`,
    );
  }
}
