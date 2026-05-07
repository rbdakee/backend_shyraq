import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { Roles } from '@/common/decorators/roles.decorator';
import { RolesGuard } from '@/common/guards/roles.guard';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';
import {
  CancelInvoiceDto,
  CreateInvoiceOneOffDto,
  InvoiceResponseDto,
  ListInvoicesQueryDto,
  ManualMarkPaidInvoiceDto,
} from './dto/invoice.dto';
import { InvoicePresenter } from './invoice.presenter';
import { InvoiceService } from './invoice.service';

const TENANT_REQUIRED = 'tenant_required';

function requireTenant(t: TenantContext): string {
  if (!t.kgId) throw new BadRequestException(TENANT_REQUIRED);
  return t.kgId;
}

/**
 * Admin-side invoice surface. Read-mostly for B13 — the only state-flip
 * mutators are `manualMarkPaid` (cash receipt) and `cancel` (admin override).
 * Auto-generation lives on the cron + cross-module hooks; one-off ad-hoc
 * invoices are created via `POST /admin/invoices`.
 */
@ApiTags('Admin / Billing — Invoices')
@ApiBearerAuth()
@Controller({ path: 'admin/invoices', version: '1' })
@UseGuards(RolesGuard)
@Roles('admin')
export class AdminInvoiceController {
  constructor(private readonly service: InvoiceService) {}

  @Get()
  @ApiOperation({
    summary:
      'List invoices (filters: status, due_date_to, child_id, invoice_type, period_start, period_end).',
  })
  @ApiOkResponse({ type: [InvoiceResponseDto] })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  async list(
    @Tenant() t: TenantContext,
    @Query() query: ListInvoicesQueryDto,
  ): Promise<InvoiceResponseDto[]> {
    const kgId = requireTenant(t);
    const invoices = await this.service.list(kgId, {
      status: query.status,
      // Repo filter currently supports only an upper-bound `dueDate`; the
      // `due_date_from` is accepted by the DTO for forward-compat but
      // ignored at the service layer until the repo lands range filters.
      dueDate: query.due_date_to,
      childId: query.child_id,
      invoiceType: query.invoice_type,
      periodStart: query.period_start,
      periodEnd: query.period_end,
    });
    return invoices.map((inv) => InvoicePresenter.one(inv));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Create a one-off ad-hoc invoice (e.g. additional service, extra fee).',
  })
  @ApiCreatedResponse({ type: InvoiceResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({ description: 'Child or payment account not found.' })
  @ApiUnprocessableEntityResponse({
    description: 'Domain invariant violation (amount, line items, dates).',
  })
  async create(
    @Tenant() t: TenantContext,
    @Body() dto: CreateInvoiceOneOffDto,
  ): Promise<InvoiceResponseDto> {
    const kgId = requireTenant(t);
    const invoice = await this.service.createOneOff(kgId, {
      childId: dto.child_id,
      invoiceType: dto.invoice_type,
      amountDue: dto.amount_due,
      dueDate: new Date(dto.due_date),
      periodStart: new Date(dto.period_start),
      periodEnd: new Date(dto.period_end),
      description: dto.description ?? null,
      discountPct: dto.discount_pct ?? null,
      discountReason: dto.discount_reason ?? null,
      lineItems: dto.line_items?.map((li) => ({
        description: li.description,
        quantity: li.quantity,
        unitPrice: li.unit_price,
        tariffPlanId: li.tariff_plan_id ?? null,
      })),
    });
    const lineItems = await this.service.listLineItems(kgId, invoice.id);
    return InvoicePresenter.one(invoice, lineItems);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single invoice with its line items.' })
  @ApiOkResponse({ type: InvoiceResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({ description: 'Invoice not found.' })
  async get(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<InvoiceResponseDto> {
    const kgId = requireTenant(t);
    const invoice = await this.service.get(kgId, id);
    const lineItems = await this.service.listLineItems(kgId, id);
    return InvoicePresenter.one(invoice, lineItems);
  }

  @Post(':id/manual-mark-paid')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Mark an invoice as paid via cash/off-platform settlement. Idempotent at the conditional-UPDATE level.',
  })
  @ApiOkResponse({ type: InvoiceResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({ description: 'Invoice not found.' })
  @ApiConflictResponse({
    description:
      'Invoice already paid / refunded / cancelled (state-machine conflict).',
  })
  async manualMarkPaid(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ManualMarkPaidInvoiceDto,
  ): Promise<InvoiceResponseDto> {
    const kgId = requireTenant(t);
    const invoice = await this.service.manualMarkPaid(kgId, id, {
      paidAt: dto.paid_at ? new Date(dto.paid_at) : undefined,
      payerUserId: dto.payer_user_id ?? null,
      note: dto.note ?? null,
    });
    return InvoicePresenter.one(invoice);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Cancel an unpaid invoice. Conditional UPDATE — already-paid invoices return 409.',
  })
  @ApiOkResponse({ type: InvoiceResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({ description: 'Invoice not found.' })
  @ApiConflictResponse({
    description:
      'Invoice already in a terminal state (paid/refunded/cancelled).',
  })
  async cancel(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CancelInvoiceDto,
  ): Promise<InvoiceResponseDto> {
    const kgId = requireTenant(t);
    const invoice = await this.service.cancel(
      kgId,
      id,
      dto.reason ?? undefined,
    );
    return InvoicePresenter.one(invoice);
  }
}
