import {
  BadRequestException,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Roles } from '@/common/decorators/roles.decorator';
import { RolesGuard } from '@/common/guards/roles.guard';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';
import { ListPaymentsQueryDto, PaymentResponseDto } from './dto/payment.dto';
import { PaymentPresenter } from './payment.presenter';
import { PaymentService } from './payment.service';

const TENANT_REQUIRED = 'tenant_required';

function requireTenant(t: TenantContext): string {
  if (!t.kgId) throw new BadRequestException(TENANT_REQUIRED);
  return t.kgId;
}

/**
 * Admin-side payments view. Read-only — manual cash payments are recorded
 * via `POST /admin/invoices/:id/manual-mark-paid`, parent-initiated
 * payments arrive via the parent app (T7b), and webhooks are settled by
 * the public webhook endpoint (T7b).
 */
@ApiTags('Admin / Billing — Payments')
@ApiBearerAuth()
@Controller({ path: 'admin/payments', version: '1' })
@UseGuards(RolesGuard)
@Roles('admin')
export class AdminPaymentController {
  constructor(private readonly service: PaymentService) {}

  @Get()
  @ApiOperation({
    summary:
      'List payments (filters: provider, status, child_id, invoice_id, refund_required, from_date, to_date). Pass invoice_id to get the payment history of a single invoice; refund_required=true for the double-payment refund queue.',
  })
  @ApiOkResponse({ type: [PaymentResponseDto] })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  async list(
    @Tenant() t: TenantContext,
    @Query() query: ListPaymentsQueryDto,
  ): Promise<PaymentResponseDto[]> {
    const kgId = requireTenant(t);
    const payments = await this.service.list(kgId, {
      provider: query.provider,
      status: query.status,
      childId: query.child_id,
      invoiceId: query.invoice_id,
      refundRequired: query.refund_required === 'true' ? true : undefined,
      fromDate: query.from_date ? new Date(query.from_date) : undefined,
      toDate: query.to_date ? new Date(query.to_date) : undefined,
    });
    return payments.map((p) => PaymentPresenter.one(p));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single payment by id.' })
  @ApiOkResponse({ type: PaymentResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({ description: 'Payment not found.' })
  async get(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<PaymentResponseDto> {
    const kgId = requireTenant(t);
    const payment = await this.service.getById(kgId, id);
    return PaymentPresenter.one(payment);
  }
}
