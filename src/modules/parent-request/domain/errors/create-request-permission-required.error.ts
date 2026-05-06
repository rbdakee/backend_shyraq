import { ForbiddenActionError } from '@/shared-kernel/domain/errors';

/**
 * 403 — the authenticated guardian does not have `permissions.create_requests = true`
 * on the requested child. They must be an approved guardian with this permission
 * enabled before they can submit any parent requests.
 */
export class CreateRequestPermissionRequiredError extends ForbiddenActionError {
  public readonly code = 'create_request_permission_required' as const;

  constructor() {
    super(
      'create_request_permission_required',
      'guardian does not have permission to create requests for this child',
    );
  }
}
