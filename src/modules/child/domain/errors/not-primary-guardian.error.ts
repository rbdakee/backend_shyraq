import { DomainError } from '@/shared-kernel/domain/errors';

/**
 * Defense-in-depth check inside parent-side service methods: only an APPROVED
 * PRIMARY guardian of the same child may approve/reject/revoke or patch
 * permissions. ChildAccessGuard normally rejects earlier; the service re-checks
 * so it stays correct when called outside an HTTP context. Mapped to HTTP 403.
 */
export class NotPrimaryGuardianError extends DomainError {
  constructor(
    public readonly userId: string,
    public readonly childId: string,
  ) {
    super(
      'not_primary_guardian',
      `user=${userId} is not an approved primary guardian of child=${childId}`,
    );
  }
}
