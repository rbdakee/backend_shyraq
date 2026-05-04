import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ChildGuardianRepository } from '@/modules/child/infrastructure/persistence/child-guardian.repository';
import type { AuthenticatedRequest } from '../types/authenticated-request';

/**
 * ChildAccessGuard — gatekeeper for parent-side endpoints under
 * `/api/v1/parent/...`.
 *
 *  - Admin / staff roles inside the same tenant pass through (admin endpoints
 *    have their own RolesGuard chain; this guard is only mounted on
 *    parent-scoped routes).
 *  - Parents must have an APPROVED guardian record for the child whose id
 *    appears in the URL parameter `:childId`. The lookup is cross-tenant on
 *    purpose — the parent JWT may not carry `kindergarten_id` until role
 *    select, and we still want to admit them on the children they are linked
 *    to.
 *
 * If the route exposes `:guardianId` instead of `:childId` (e.g.
 * `/parent/approvals/:guardianId/approve`), the guard resolves the guardian
 * row to find its child and reuses the same approval check.
 */
@Injectable()
export class ChildAccessGuard implements CanActivate {
  constructor(private readonly guardians: ChildGuardianRepository) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = req.user;
    if (!user) return false;

    // Admin / staff / super_admin / support paths — out of scope for this
    // guard. They only mount this guard on parent-scoped controllers.
    if (user.role !== 'parent') return true;

    const params = req.params as Record<string, string | undefined>;
    let childId = params['childId'] ?? params['id'];

    if (!childId && params['guardianId']) {
      const g = await this.guardians.findByIdCrossTenant(params['guardianId']);
      if (!g) {
        throw new ForbiddenException('child_access_denied');
      }
      childId = g.childId;
    }

    if (!childId) {
      // Routes without a child / guardian id (e.g. listMyChildren) skip the
      // guard — they apply their own per-row scoping inside the service. We
      // intentionally do NOT touch `req.tenant` here: KindergartenScopeGuard
      // has already populated it from the JWT (kg-scoped parent) or left it
      // null (unscoped parent — the controller routes that branch to a
      // cross-tenant service path).
      return true;
    }

    const guardian = await this.guardians.findApprovedByChildAndUserCrossTenant(
      childId,
      user.sub,
    );
    if (!guardian) {
      throw new ForbiddenException('child_access_denied');
    }

    // The approved guardian row carries the kindergarten the parent is acting
    // for. Pin `req.tenant` to that kg so the downstream
    // TenantContextInterceptor can issue `SET LOCAL app.kindergarten_id` and
    // RLS still applies — the parent JWT may not carry `kindergarten_id`
    // (multi-kg or freshly-linked-but-not-yet-rotated tokens), so without
    // this hook the controller would either reject as `tenant_required` or
    // act under a stale kg. Stash the guardian record itself for forward-
    // looking permission decorators (architecture.md §4.5).
    req.tenant = {
      kgId: guardian.kindergartenId,
      bypass: false,
    };
    req.guardianRecord = guardian;
    return true;
  }
}
