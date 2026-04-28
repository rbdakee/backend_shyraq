import type { Request } from 'express';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import type { JwtPayload } from './jwt-payload';

/**
 * Express request augmented with auth + tenant scope. Populated by guards
 * (JwtAuthGuard fills `user`, KindergartenScopeGuard fills `tenant`) and read
 * by TenantContextInterceptor.
 */
export interface AuthenticatedRequest extends Request {
  user?: JwtPayload;
  tenant?: TenantContext;
}
