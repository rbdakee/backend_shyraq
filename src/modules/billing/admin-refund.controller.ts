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
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import { RolesGuard } from '@/common/guards/roles.guard';
import type { JwtPayload } from '@/common/types/jwt-payload';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';
import {
  ApproveRefundDto,
  CreateRefundDto,
  ListRefundsQueryDto,
  RefundResponseDto,
} from './dto/refund.dto';
import { RefundPresenter } from './refund.presenter';
import { RefundService } from './refund.service';

const TENANT_REQUIRED = 'tenant_required';

function requireTenant(t: TenantContext): string {
  if (!t.kgId) throw new BadRequestException(TENANT_REQUIRED);
  return t.kgId;
}

/**
 * Admin-driven refund flow. State machine:
 *
 *   create  → pending
 *   approve → approved (locks the row, processed_by from req.user)
 *   process → processed (calls payment provider, atomically debits ledger)
 *
 * Reject is intentionally not exposed yet — admins can simply leave a
 * refund in `pending` and create a new one when the customer agrees on a
 * different amount. A reject endpoint will be added when the parent UI
 * grows a "decline refund" affordance.
 */
@ApiTags('Admin / Billing — Refunds')
@ApiBearerAuth()
@Controller({ path: 'admin/refunds', version: '1' })
@UseGuards(RolesGuard)
@Roles('admin')
export class AdminRefundController {
  constructor(private readonly service: RefundService) {}

  @Get()
  @ApiOperation({ summary: 'List refunds (filters: status, payment_id).' })
  @ApiOkResponse({ type: [RefundResponseDto] })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  async list(
    @Tenant() t: TenantContext,
    @Query() query: ListRefundsQueryDto,
  ): Promise<RefundResponseDto[]> {
    const kgId = requireTenant(t);
    const refunds = await this.service.list(kgId, {
      status: query.status,
      paymentId: query.payment_id,
    });
    return refunds.map((r) => RefundPresenter.one(r));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single refund by id.' })
  @ApiOkResponse({ type: RefundResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({ description: 'Refund not found.' })
  async get(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<RefundResponseDto> {
    const kgId = requireTenant(t);
    const refund = await this.service.getById(kgId, id);
    return RefundPresenter.one(refund);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Create a pending refund request against a completed payment. Amount must be <= payment.amount.',
  })
  @ApiCreatedResponse({ type: RefundResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({ description: 'Payment not found.' })
  @ApiConflictResponse({ description: 'Payment is not in completed state.' })
  @ApiUnprocessableEntityResponse({
    description: 'Refund amount invalid (<= 0 or exceeds payment.amount).',
  })
  async create(
    @Tenant() t: TenantContext,
    @Body() dto: CreateRefundDto,
  ): Promise<RefundResponseDto> {
    const kgId = requireTenant(t);
    const refund = await this.service.create(kgId, {
      paymentId: dto.payment_id,
      amount: dto.amount,
      reason: dto.reason,
    });
    return RefundPresenter.one(refund);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Approve a pending refund. processed_by is taken from req.user.sub.',
  })
  @ApiOkResponse({ type: RefundResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({ description: 'Refund not found.' })
  @ApiConflictResponse({
    description:
      'Refund is not in pending state (already approved/processed/rejected).',
  })
  async approve(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() _dto: ApproveRefundDto,
  ): Promise<RefundResponseDto> {
    const kgId = requireTenant(t);
    const refund = await this.service.approve(kgId, id, {
      processedBy: user.sub,
    });
    return RefundPresenter.one(refund);
  }

  @Post(':id/process')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Process an approved refund — calls the payment provider and atomically debits the payment account.',
  })
  @ApiOkResponse({ type: RefundResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({ description: 'Refund or payment not found.' })
  @ApiConflictResponse({
    description:
      'Refund not in approved state, or payment no longer completed.',
  })
  async process(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<RefundResponseDto> {
    const kgId = requireTenant(t);
    const refund = await this.service.process(kgId, id);
    return RefundPresenter.one(refund);
  }
}
