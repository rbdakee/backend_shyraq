import { ForbiddenActionError } from '@/shared-kernel/domain/errors';

/**
 * A primary guardian attempted to self-unlink from a child. Primary lives
 * for the lifetime of the child profile (until archive); only an admin can
 * remove a primary via the child-lifecycle path. Secondary/nanny guardians
 * may self-unlink freely. Mapped to HTTP 403.
 */
export class PrimaryCannotSelfUnlinkError extends ForbiddenActionError {
  constructor(
    public readonly childId: string,
    public readonly userId: string,
  ) {
    super(
      'primary_cannot_self_unlink',
      `primary guardian user=${userId} cannot self-unlink from child=${childId}`,
    );
  }
}
