import { NotFoundError } from '@/shared-kernel/domain/errors';

/**
 * 404 — caller asked for a parent_request id that is not visible under
 * the caller's tenant scope (or simply does not exist).
 */
export class ParentRequestNotFoundError extends NotFoundError {
  public readonly code = 'parent_request_not_found' as const;

  constructor(requestId: string) {
    super('parent_request', requestId);
  }
}
