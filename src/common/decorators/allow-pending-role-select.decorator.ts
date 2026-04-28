import { SetMetadata } from '@nestjs/common';

/**
 * Allows handlers that are part of the role-selection flow to accept JWTs
 * with `pending_role_select: true`. PendingRoleSelectGuard checks this
 * metadata before refusing the request.
 */
export const ALLOW_PENDING_ROLE_SELECT_KEY = 'allowPendingRoleSelect';
export const AllowPendingRoleSelect = (): ClassDecorator & MethodDecorator =>
  SetMetadata(ALLOW_PENDING_ROLE_SELECT_KEY, true);
