import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TrustedPersonRepository } from '@/modules/pickup/infrastructure/persistence/trusted-person.repository';
import type { AuthenticatedRequest } from '../types/authenticated-request';

/**
 * TrustedPersonAccessGuard (Пакет C) — resolves the owning kindergarten of a
 * `trusted_people` row from the URL `:id` so the parent-side
 * `PATCH /parent/trusted-people/:id` and `POST /parent/trusted-people/:id/revoke`
 * routes no longer depend on the JWT's `kindergarten_id`.
 *
 * The tenant of a trusted_people row is an attribute of the RESOURCE (its
 * child), not the caller's token. The multi-kg parent JWT carries
 * `kindergarten_id: null` by design, so the kg is read off the resolved row
 * (cross-tenant, bypass-RLS in its own TX) and pinned onto `req.tenant`; the
 * downstream `TenantContextInterceptor` then scopes the transaction (RLS
 * active) and the service re-checks ownership (original adder OR
 * approved-active guardian of the same child) in that kg. The cross-tenant
 * lookup resolves the kg ONLY — no authorisation — so a guardian on kg_A can
 * never patch/revoke a row from kg_B even with a hand-crafted URL: the
 * service's ownership check in the resolved kg fails with 403.
 *
 *  - Non-parent roles pass through (parent-scoped controller).
 *  - Routes without an `:id` param pass through untouched.
 *
 * Mirrors `InvoiceAccessGuard`.
 */
@Injectable()
export class TrustedPersonAccessGuard implements CanActivate {
  constructor(private readonly trustedPeople: TrustedPersonRepository) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = req.user;
    if (!user) return false;
    if (user.role !== 'parent') return true;

    const params = req.params as Record<string, string | undefined>;
    const id = params['id'];
    if (!id) return true;

    const tp = await this.trustedPeople.findByIdCrossTenant(id);
    if (!tp) {
      throw new NotFoundException('trusted_person_not_found');
    }

    req.tenant = {
      kgId: tp.kindergartenId,
      bypass: false,
    };
    return true;
  }
}
