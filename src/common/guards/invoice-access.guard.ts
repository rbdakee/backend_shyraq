import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InvoiceRepository } from '@/modules/billing/infrastructure/persistence/invoice.repository';
import type { AuthenticatedRequest } from '../types/authenticated-request';

/**
 * InvoiceAccessGuard — resolves the owning kindergarten of an invoice from the
 * URL `:id` so parent-side `/parent/invoices/:id*` routes (read + pay) no
 * longer depend on the JWT's `kindergarten_id`.
 *
 * The tenant of an invoice is an attribute of the RESOURCE (its child), not the
 * caller's token. The kg is read off the resolved invoice and pinned onto
 * `req.tenant`; the downstream `TenantContextInterceptor` then scopes the
 * transaction (RLS active) and the service re-checks guardian-of-child (read)
 * or assertCanPay (pay) in that kg. The cross-tenant lookup resolves the kg
 * ONLY — no authorisation — so an approved guardian on kg_A can never read or
 * pay an invoice from kg_B even with a hand-crafted URL: the service's
 * guardian/canPay check in the resolved kg fails with 403.
 *
 *  - Non-parent roles pass through (parent-scoped controllers).
 *  - Routes without an `:id` param pass through untouched.
 */
@Injectable()
export class InvoiceAccessGuard implements CanActivate {
  constructor(private readonly invoices: InvoiceRepository) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = req.user;
    if (!user) return false;
    if (user.role !== 'parent') return true;

    const params = req.params as Record<string, string | undefined>;
    const id = params['id'];
    if (!id) return true;

    const invoice = await this.invoices.findByIdCrossTenant(id);
    if (!invoice) {
      throw new NotFoundException('invoice_not_found');
    }

    req.tenant = {
      kgId: invoice.kindergartenId,
      bypass: false,
    };
    return true;
  }
}
