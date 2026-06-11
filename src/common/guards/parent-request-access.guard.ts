import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ParentRequestRepository } from '@/modules/parent-request/parent-request.repository';
import type { AuthenticatedRequest } from '../types/authenticated-request';

/**
 * ParentRequestAccessGuard — resolves the owning kindergarten of a
 * parent_request from the URL `:id` so parent-side `/parent/requests/:id/*`
 * routes no longer depend on the JWT's `kindergarten_id`.
 *
 * The tenant of a parent_request is an attribute of the RESOURCE, not the
 * caller's token: the kg is read off the resolved row and pinned onto
 * `req.tenant`, after which the downstream `TenantContextInterceptor` scopes
 * the transaction (RLS active) and the service re-checks requester-ownership
 * in that kg. The cross-tenant lookup here resolves the kg ONLY — it performs
 * no authorisation, so a request that exists but belongs to another user is
 * still rejected by the service's ownership check (403), and a request that
 * does not exist anywhere yields a 404.
 *
 *  - Non-parent roles pass through (parent-scoped controllers).
 *  - Routes without an `:id` param pass through untouched.
 */
@Injectable()
export class ParentRequestAccessGuard implements CanActivate {
  constructor(private readonly parentRequests: ParentRequestRepository) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = req.user;
    if (!user) return false;
    if (user.role !== 'parent') return true;

    const params = req.params as Record<string, string | undefined>;
    const id = params['id'];
    if (!id) return true;

    const pr = await this.parentRequests.findByIdCrossTenant(id);
    if (!pr) {
      throw new NotFoundException('parent_request_not_found');
    }

    req.tenant = {
      kgId: pr.kindergartenId,
      bypass: false,
    };
    return true;
  }
}
