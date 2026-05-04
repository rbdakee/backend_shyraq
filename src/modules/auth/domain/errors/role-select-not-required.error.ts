import { ForbiddenActionError } from '@/shared-kernel/domain/errors';

/**
 * Thrown when /auth/role/select is called with a regular (non-pending) JWT.
 * Only JWTs that carry `pending_role_select: true` may proceed through this
 * endpoint. Maps to HTTP 403.
 */
export class RoleSelectNotRequiredError extends ForbiddenActionError {
  constructor() {
    super('role_select_not_required');
  }
}
