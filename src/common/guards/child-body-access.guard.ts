import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ChildGuardianRepository } from '@/modules/child/infrastructure/persistence/child-guardian.repository';
import type { AuthenticatedRequest } from '../types/authenticated-request';

/**
 * ChildBodyAccessGuard — the body-keyed sibling of {@link ChildAccessGuard}.
 *
 * Used on parent-side CREATE endpoints that carry `child_id` in the request
 * BODY rather than the URL (e.g. `POST /parent/requests/vacation`). The owning
 * kindergarten is an attribute of the CHILD, not the parent: a parent's
 * authority to file a request is "approved guardian of that child", and the kg
 * the operation runs in is derived from the child — never from the JWT's
 * `kindergarten_id` (which is only an optimisation slice for single-kg parents
 * and is `null` by design for multi-kg parents).
 *
 *  - Non-parent roles pass through (these controllers are parent-scoped; admin
 *    /staff have their own guard chains).
 *  - The lookup is cross-tenant on purpose — the parent JWT may carry no
 *    `kindergarten_id`, and the child may live in a different kg than the
 *    token's slice. A parent is admitted only when they hold an APPROVED
 *    guardian record for the body's `child_id`; the guard then pins
 *    `req.tenant` to that guardian's kg so the downstream
 *    `TenantContextInterceptor` issues `SET LOCAL app.kindergarten_id` and RLS
 *    applies to every subsequent query. The service still re-checks the finer
 *    `create_requests` permission (and nanny gating) in that kg
 *    (defense-in-depth).
 *
 * When the body has no usable `child_id`, the guard defers to the DTO
 * ValidationPipe (which runs after guards) to surface the canonical 400 — it
 * does NOT pin `req.tenant`, leaving the request to run under the token kg
 * (single-kg parent) or trip `tenant_required`.
 */
@Injectable()
export class ChildBodyAccessGuard implements CanActivate {
  constructor(private readonly guardians: ChildGuardianRepository) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = req.user;
    if (!user) return false;
    if (user.role !== 'parent') return true;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const childId = body['child_id'];
    if (typeof childId !== 'string' || childId.length === 0) {
      return true;
    }

    const guardian = await this.guardians.findApprovedByChildAndUserCrossTenant(
      childId,
      user.sub,
    );
    if (!guardian) {
      throw new ForbiddenException('child_access_denied');
    }

    req.tenant = {
      kgId: guardian.kindergartenId,
      bypass: false,
    };
    req.guardianRecord = guardian;
    return true;
  }
}
