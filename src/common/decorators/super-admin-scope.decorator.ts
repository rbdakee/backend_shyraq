import { SetMetadata } from '@nestjs/common';

/**
 * Marks a handler/class as running in the SaaS-operator scope (super_admin or
 * support roles). Read by KindergartenScopeGuard (allow privileged roles
 * through without a kindergarten_id) and TenantContextInterceptor (sets
 * `app.bypass_rls = true` for the wrapping transaction).
 */
export const SUPER_ADMIN_SCOPE_KEY = 'superAdminScope';
export const SuperAdminScope = (): ClassDecorator & MethodDecorator =>
  SetMetadata(SUPER_ADMIN_SCOPE_KEY, true);
