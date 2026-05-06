import { ForbiddenActionError } from '@/shared-kernel/domain/errors';

/**
 * 403 — caller attempted to read or act on a parent_request they are not
 * authorised to access (e.g. parent accessing another parent's request,
 * specialist accessing a request directed to a different recipient).
 *
 * Intentionally generic — no PII about the actual owner is returned.
 */
export class ParentRequestForbiddenError extends ForbiddenActionError {
  public readonly code = 'parent_request_forbidden' as const;

  constructor() {
    super(
      'parent_request_forbidden',
      'access to this parent request is forbidden',
    );
  }
}
