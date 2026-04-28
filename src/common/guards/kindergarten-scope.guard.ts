import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { SUPER_ADMIN_SCOPE_KEY } from '../decorators/super-admin-scope.decorator';
import type { AuthenticatedRequest } from '../types/authenticated-request';

/**
 * Builds TenantContext from req.user + @SuperAdminScope() metadata and stores
 * it on req.tenant. The AsyncLocalStorage scope itself is set by
 * TenantContextInterceptor — guards cannot own `tenantStorage.run(...)`
 * because they return before the handler is called and ALS.enterWith does not
 * propagate to the NestJS handler invocation frame.
 */
@Injectable()
export class KindergartenScopeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const isPublic =
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
        ctx.getHandler(),
        ctx.getClass(),
      ]) ?? false;
    if (isPublic) return true;

    const isSuperAdminScope =
      this.reflector.getAllAndOverride<boolean>(SUPER_ADMIN_SCOPE_KEY, [
        ctx.getHandler(),
        ctx.getClass(),
      ]) ?? false;

    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = req.user;
    if (!user) return true;

    const isPrivileged = user.role === 'super_admin' || user.role === 'support';
    const allow = isSuperAdminScope || !isPrivileged;
    if (!allow) return false;

    req.tenant = {
      kgId: user.kindergarten_id ?? null,
      bypass: isPrivileged,
    };
    return true;
  }
}
