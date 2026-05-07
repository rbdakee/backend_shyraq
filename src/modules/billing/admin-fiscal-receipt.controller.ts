import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
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
import {
  FiscalReceiptResponseDto,
  ListFiscalReceiptsQueryDto,
} from './dto/fiscal-receipt.dto';

const TENANT_REQUIRED = 'tenant_required';

function requireTenant(t: TenantContext): string {
  if (!t.kgId) throw new BadRequestException(TENANT_REQUIRED);
  return t.kgId;
}

/**
 * AdminFiscalReceiptController — read-only stub for B13.
 *
 * The Mock fiscal-receipt adapter wired into BillingModule emits receipts
 * synchronously during payment completion, but B13 does NOT yet persist
 * those receipts to a queryable table — the OFD adapters (Kassa24,
 * Rekassa, Webkassa) and their persistence model land in B15. This stub
 * exists so the parent app and admin UI can call the documented endpoints
 * without blowing up on 404s.
 *
 * TODO(B15): wire the real `FiscalReceiptRepository`, return persisted
 * rows from `list`, replace 404 in `get` with a hydrated response.
 */
@ApiTags('Admin / Billing — Fiscal Receipts (B13 stub)')
@ApiBearerAuth()
@Controller({ path: 'admin/fiscal-receipts', version: '1' })
@UseGuards(RolesGuard)
@Roles('admin')
export class AdminFiscalReceiptController {
  @Get()
  @ApiOperation({
    summary:
      'List fiscal receipts. B13 stub returns an empty array — full implementation lands in B15.',
  })
  @ApiOkResponse({ type: [FiscalReceiptResponseDto] })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  list(
    @Tenant() t: TenantContext,
    @Query() _query: ListFiscalReceiptsQueryDto,
  ): Promise<FiscalReceiptResponseDto[]> {
    requireTenant(t);
    // TODO(B15): replace with FiscalReceiptRepository.list(kgId, filter).
    return Promise.resolve([]);
  }

  @Get(':id')
  @ApiOperation({
    summary:
      'Get a fiscal receipt by id. B13 stub always returns 404 — full implementation lands in B15.',
  })
  @ApiOkResponse({ type: FiscalReceiptResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({
    description: 'Fiscal receipt not found or pending (B13 stub).',
  })
  get(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) _id: string,
  ): Promise<FiscalReceiptResponseDto> {
    requireTenant(t);
    // TODO(B15): replace with FiscalReceiptRepository.findById(kgId, id).
    return Promise.reject(
      new NotFoundException('fiscal_receipt_not_found_or_pending'),
    );
  }
}
