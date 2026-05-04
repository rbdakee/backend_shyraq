import { ForbiddenActionError } from '@/shared-kernel/domain/errors';

/**
 * A primary guardian attempted to revoke their own guardian row via the
 * primary-side approval endpoint (`POST /parent/approvals/:guardianId/revoke`).
 * Primary lifecycle is admin-managed; only an admin can remove a primary via
 * the child-lifecycle path. Mapped to HTTP 403.
 */
export class PrimaryCannotSelfRevokeError extends ForbiddenActionError {
  constructor(public readonly userId: string) {
    super(
      'primary_cannot_self_revoke',
      `primary guardian user=${userId} cannot revoke their own guardian row`,
    );
  }
}
