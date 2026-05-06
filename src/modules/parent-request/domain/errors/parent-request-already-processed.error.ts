import { ConflictError } from '@/shared-kernel/domain/errors';

/**
 * 409 — concurrent state-flip race: two callers simultaneously tried to
 * transition the same request (e.g. accept + reject at the same time).
 * The conditional UPDATE (`WHERE status='pending'`) returned 0 rows,
 * indicating the first caller already processed it.
 */
export class ParentRequestAlreadyProcessedError extends ConflictError {
  public readonly code = 'parent_request_already_processed' as const;

  constructor(requestId: string) {
    super(
      'parent_request_already_processed',
      `parent request already processed: ${requestId}`,
    );
  }
}
