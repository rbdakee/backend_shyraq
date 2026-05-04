import type { Request } from 'express';
import type { ChildGuardian } from '@/modules/child/domain/entities/child-guardian.entity';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import type { JwtPayload } from './jwt-payload';

/**
 * Express request augmented with auth + tenant scope. Populated by guards
 * (JwtAuthGuard fills `user`, KindergartenScopeGuard fills `tenant`,
 * ChildAccessGuard fills `tenant` from the resolved guardian row + stashes
 * the `guardianRecord` for downstream permission decorators) and read by
 * TenantContextInterceptor.
 */
export interface AuthenticatedRequest extends Request {
  user?: JwtPayload;
  tenant?: TenantContext;
  /**
   * Set by ChildAccessGuard once it resolves the approved guardian row for
   * the calling parent on the URL `:childId`/`:guardianId`. Forward-looking
   * for permission decorators (e.g. `@PrimaryGuardian()`) — current parent
   * controllers re-validate inside the service for defense-in-depth.
   */
  guardianRecord?: ChildGuardian;
}
