import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import { ChildAccessGuard } from '@/common/guards/child-access.guard';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { PendingRoleSelectGuard } from '@/common/guards/pending-role-select.guard';
import { RolesGuard } from '@/common/guards/roles.guard';
import type { JwtPayload } from '@/common/types/jwt-payload';
import { ChildGuardianRepository } from '@/modules/child/infrastructure/persistence/child-guardian.repository';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';
import {
  InvoiceResponseDto,
  ListInvoicesQueryDto,
  PaymentCalendarResponseDto,
} from './dto/invoice.dto';
import { InvoicePresenter } from './invoice.presenter';
import { InvoiceService } from './invoice.service';

const TENANT_REQUIRED = 'tenant_required';

function requireTenant(t: TenantContext): string {
  if (!t.kgId) throw new BadRequestException(TENANT_REQUIRED);
  return t.kgId;
}

/**
 * Parent-side read endpoints for invoices + payment calendar.
 *
 * Guards:
 *   - Per-route under `:childId` → `ChildAccessGuard` (cross-tenant lookup;
 *     pins `req.tenant` to the guardian's kg, then checks approved-active).
 *   - Per-route under `:id` (invoice id) → tenant comes from `KindergartenScopeGuard`
 *     (parent JWT after role-select); we then revalidate guardian-of-child via
 *     `ChildGuardianRepository.findApprovedActiveByUserAndChild` so an approved
 *     guardian on kg_A can never read invoice from kg_B even with a hand-crafted
 *     URL.
 *
 * Permission gate (BP §4.13):
 *   - primary / secondary → allowed.
 *   - nanny → 403 `nanny_cannot_view_invoice` on every route. Notification
 *     dispatcher's nanny-policy filter already prevents `invoice.*` events
 *     from reaching nanny devices, so blocking READ here is the symmetric
 *     check.
 */
@ApiTags('Parent / Billing — Invoices')
@ApiBearerAuth()
@Controller({ path: 'parent', version: '1' })
@UseGuards(JwtAuthGuard, PendingRoleSelectGuard, ChildAccessGuard, RolesGuard)
@Roles('parent')
export class ParentInvoiceController {
  constructor(
    private readonly service: InvoiceService,
    private readonly guardians: ChildGuardianRepository,
  ) {}

  @Get('children/:childId/invoices')
  @ApiOperation({
    summary:
      'List invoices for the child. Filters: status, invoice_type, due_date_from, due_date_to. Guardian-link role gate: nanny → 403.',
  })
  @ApiOkResponse({ type: [InvoiceResponseDto] })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({
    description:
      'child_access_denied (not an approved guardian) / nanny_cannot_view_invoice.',
  })
  async listForChild(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Param('childId', new ParseUUIDPipe()) childId: string,
    @Query() query: ListInvoicesQueryDto,
  ): Promise<InvoiceResponseDto[]> {
    const kgId = requireTenant(t);
    await this.assertNonNannyGuardian(kgId, user.sub, childId);
    const invoices = await this.service.list(kgId, {
      childId,
      status: query.status,
      dueDate: query.due_date_to,
      invoiceType: query.invoice_type,
      periodStart: query.period_start,
      periodEnd: query.period_end,
    });
    return invoices.map((inv) => InvoicePresenter.one(inv));
  }

  @Get('invoices/:id')
  @ApiOperation({
    summary:
      'Get a single invoice with its line items. Re-checks guardian-of-child access; nanny → 403.',
  })
  @ApiOkResponse({ type: InvoiceResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({
    description: 'not_a_guardian / nanny_cannot_view_invoice.',
  })
  @ApiNotFoundResponse({ description: 'invoice_not_found.' })
  async getOne(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<InvoiceResponseDto> {
    const kgId = requireTenant(t);
    const invoice = await this.service.get(kgId, id);
    await this.assertNonNannyGuardian(kgId, user.sub, invoice.childId);
    const lineItems = await this.service.listLineItems(kgId, id);
    return InvoicePresenter.one(invoice, lineItems);
  }

  @Get('children/:childId/payment-calendar')
  @ApiOperation({
    summary:
      'Kaspi-style payment calendar for the child. `months_ahead` ∈ [1, 24]. Returns one entry per month — real invoices where present, projected entries (status=projected) for unfilled months. Nanny → 403.',
  })
  @ApiOkResponse({ type: PaymentCalendarResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({
    description: 'child_access_denied / nanny_cannot_view_invoice.',
  })
  async paymentCalendar(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Param('childId', new ParseUUIDPipe()) childId: string,
    @Query('months_ahead', new ParseIntPipe({ optional: true }))
    monthsAhead?: number,
  ): Promise<PaymentCalendarResponseDto> {
    const kgId = requireTenant(t);
    await this.assertNonNannyGuardian(kgId, user.sub, childId);
    const horizon = monthsAhead ?? 12;
    const entries = await this.service.buildPaymentCalendar(
      kgId,
      childId,
      horizon,
    );
    return {
      child_id: childId,
      months_ahead: horizon,
      invoices: entries,
    };
  }

  /**
   * Re-check guardian-of-child link in the resolved tenant. `ChildAccessGuard`
   * already verifies cross-tenant approved status for `:childId` routes, but
   * (a) `:id` invoice routes need an explicit re-check anyway, and (b) the
   * guardian role itself isn't surfaced by the guard — we need it here to
   * gate nanny.
   */
  private async assertNonNannyGuardian(
    kgId: string,
    userId: string,
    childId: string,
  ): Promise<void> {
    const guardian = await this.guardians.findApprovedActiveByUserAndChild(
      kgId,
      childId,
      userId,
    );
    if (!guardian) {
      throw new ForbiddenException('not_a_guardian');
    }
    if (guardian.role.value === 'nanny') {
      throw new ForbiddenException('nanny_cannot_view_invoice');
    }
  }
}
