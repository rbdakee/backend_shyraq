import { NotFoundError } from '@/shared-kernel/domain/errors';

/**
 * 404 — staff or admin asked for a pickup_request id that is not visible
 * under the caller's tenant scope (or simply does not exist). Module-
 * specific `code` so the staff client can disambiguate from generic 404s.
 */
export class PickupRequestNotFoundError extends NotFoundError {
  public readonly code = 'pickup_request_not_found' as const;

  constructor(requestId: string) {
    super('pickup_request', requestId);
  }
}
