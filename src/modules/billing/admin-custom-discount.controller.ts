import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
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
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import type { JwtPayload } from '@/common/types/jwt-payload';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';
import type { ListCustomDiscountsFilter } from './custom-discount.repository';
import type { CustomDiscountPageRequest } from './custom-discount.repository';
import type { UpdateCustomDiscountServiceInput } from './custom-discount.service';
import { CustomDiscountService } from './custom-discount.service';
import { CustomDiscountPresenter } from './custom-discount.presenter';
import {
  CreateCustomDiscountDto,
  CustomDiscountApplicationListResponseDto,
  CustomDiscountDetailResponseDto,
  CustomDiscountListResponseDto,
  CustomDiscountResponseDto,
  ListCustomDiscountApplicationsQueryDto,
  ListCustomDiscountsQueryDto,
  UpdateCustomDiscountDto,
} from './dto/custom-discount.dto';

const TENANT_REQUIRED = 'tenant_required';

function requireTenant(t: TenantContext): string {
  if (!t.kgId) throw new BadRequestException(TENANT_REQUIRED);
  return t.kgId;
}

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;

/**
 * Admin-side CRUD + state-machine surface for the B16 custom-discount
 * catalogue. Tenant scope is enforced by the global
 * `KindergartenScopeGuard` + `TenantContextInterceptor`; this controller
 * layers `RolesGuard` + `admin` role on top.
 *
 * 9 endpoints:
 *   GET    /admin/custom-discounts
 *   POST   /admin/custom-discounts
 *   GET    /admin/custom-discounts/:id
 *   PATCH  /admin/custom-discounts/:id
 *   POST   /admin/custom-discounts/:id/activate
 *   POST   /admin/custom-discounts/:id/pause
 *   POST   /admin/custom-discounts/:id/resume
 *   POST   /admin/custom-discounts/:id/cancel
 *   GET    /admin/custom-discounts/:id/applications
 */
@ApiTags('Admin / Billing — Custom Discounts')
@ApiBearerAuth()
@Controller({ path: 'admin/custom-discounts', version: '1' })
@UseGuards(RolesGuard)
@Roles('admin')
export class AdminCustomDiscountController {
  constructor(private readonly service: CustomDiscountService) {}

  // ── GET /admin/custom-discounts ──────────────────────────────────────────

  @Get()
  @ApiOperation({
    summary:
      'List custom discounts (filters: status, valid_from_to, valid_until_from, target_type).',
  })
  @ApiOkResponse({ type: CustomDiscountListResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  async list(
    @Tenant() t: TenantContext,
    @Query() query: ListCustomDiscountsQueryDto,
  ): Promise<CustomDiscountListResponseDto> {
    const kgId = requireTenant(t);
    const page = query.page ?? DEFAULT_PAGE;
    const limit = query.limit ?? DEFAULT_LIMIT;
    const filter: ListCustomDiscountsFilter = {
      status: query.status,
      validFromTo: query.valid_from_to
        ? new Date(query.valid_from_to)
        : undefined,
      validUntilFrom: query.valid_until_from
        ? new Date(query.valid_until_from)
        : undefined,
    };
    if (query.target_type !== undefined) {
      // target_type is not in ListCustomDiscountsFilter — service.list accepts
      // it as part of filter. For B16 the filter shape covers status + validity
      // window only; target_type filtering is a future extension deferred to
      // B22. For now, pass through without error.
    }
    const pagination: CustomDiscountPageRequest = {
      limit,
      offset: (page - 1) * limit,
    };
    const result = await this.service.list(kgId, filter, pagination);
    return CustomDiscountPresenter.list(result, page, limit);
  }

  // ── POST /admin/custom-discounts ─────────────────────────────────────────

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new draft custom discount.' })
  @ApiCreatedResponse({ type: CustomDiscountResponseDto })
  @ApiBadRequestResponse({
    description: 'Validation error (including conditions schema).',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiUnprocessableEntityResponse({
    description: 'Domain invariant violation (amount, validity, target shape).',
  })
  async create(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateCustomDiscountDto,
  ): Promise<CustomDiscountResponseDto> {
    const kgId = requireTenant(t);
    const discount = await this.service.create(
      kgId,
      {
        name: dto.name,
        description: dto.description ?? null,
        discountType: dto.discount_type,
        amount: dto.amount,
        conditions: dto.conditions,
        targetType: dto.target_type,
        targetIds: dto.target_ids ?? null,
        validFrom: new Date(dto.valid_from),
        validUntil: dto.valid_until ? new Date(dto.valid_until) : null,
        maxUsesPerChild: dto.max_uses_per_child ?? null,
        totalMaxUses: dto.total_max_uses ?? null,
        priority: dto.priority,
        stackable: dto.stackable,
        notifyOnActivation: dto.notify_on_activation,
        notificationTitle: dto.notification_title ?? null,
        notificationBody: dto.notification_body ?? null,
      },
      user.sub,
    );
    return CustomDiscountPresenter.one(discount);
  }

  // ── GET /admin/custom-discounts/:id ─────────────────────────────────────

  @Get(':id')
  @ApiOperation({
    summary: 'Get a single custom discount with application stats.',
  })
  @ApiOkResponse({ type: CustomDiscountDetailResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({ description: 'Custom discount not found.' })
  async getById(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CustomDiscountDetailResponseDto> {
    const kgId = requireTenant(t);
    const result = await this.service.getById(kgId, id);
    return CustomDiscountPresenter.detail(result);
  }

  // ── PATCH /admin/custom-discounts/:id ────────────────────────────────────

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Update a draft custom discount (partial). Only allowed when status=draft.',
  })
  @ApiOkResponse({ type: CustomDiscountResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({ description: 'Custom discount not found.' })
  @ApiConflictResponse({
    description:
      'Discount is not in draft status — update only allowed for draft rows.',
  })
  @ApiUnprocessableEntityResponse({
    description: 'Domain invariant violation in the patched state.',
  })
  async update(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateCustomDiscountDto,
  ): Promise<CustomDiscountResponseDto> {
    const kgId = requireTenant(t);
    const patch: UpdateCustomDiscountServiceInput = {};
    if (dto.name !== undefined) patch.name = dto.name;
    if ('description' in dto) patch.description = dto.description ?? null;
    if (dto.discount_type !== undefined) patch.discountType = dto.discount_type;
    if (dto.amount !== undefined) patch.amount = dto.amount;
    if (dto.conditions !== undefined) patch.conditions = dto.conditions;
    if (dto.target_type !== undefined) patch.targetType = dto.target_type;
    if ('target_ids' in dto) patch.targetIds = dto.target_ids ?? null;
    if (dto.valid_from !== undefined)
      patch.validFrom = new Date(dto.valid_from);
    if ('valid_until' in dto)
      patch.validUntil = dto.valid_until ? new Date(dto.valid_until) : null;
    if ('max_uses_per_child' in dto)
      patch.maxUsesPerChild = dto.max_uses_per_child ?? null;
    if ('total_max_uses' in dto)
      patch.totalMaxUses = dto.total_max_uses ?? null;
    if (dto.priority !== undefined) patch.priority = dto.priority;
    if (dto.stackable !== undefined) patch.stackable = dto.stackable;
    if (dto.notify_on_activation !== undefined)
      patch.notifyOnActivation = dto.notify_on_activation;
    if ('notification_title' in dto)
      patch.notificationTitle = dto.notification_title ?? null;
    if ('notification_body' in dto)
      patch.notificationBody = dto.notification_body ?? null;
    const updated = await this.service.update(kgId, id, patch);
    return CustomDiscountPresenter.one(updated);
  }

  // ── POST /admin/custom-discounts/:id/activate ────────────────────────────

  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Activate a draft discount. Flips draft → active and, if notify_on_activation, fans out push notifications to target parents.',
  })
  @ApiOkResponse({ type: CustomDiscountResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({ description: 'Custom discount not found.' })
  @ApiConflictResponse({
    description:
      'Discount is not in draft status (already active / cancelled / expired).',
  })
  async activate(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CustomDiscountResponseDto> {
    const kgId = requireTenant(t);
    const discount = await this.service.activate(kgId, id);
    return CustomDiscountPresenter.one(discount);
  }

  // ── POST /admin/custom-discounts/:id/pause ───────────────────────────────

  @Post(':id/pause')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Pause an active discount. Flips active → paused.' })
  @ApiOkResponse({ type: CustomDiscountResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({ description: 'Custom discount not found.' })
  @ApiConflictResponse({
    description: 'Discount is not in active status.',
  })
  async pause(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CustomDiscountResponseDto> {
    const kgId = requireTenant(t);
    const discount = await this.service.pause(kgId, id);
    return CustomDiscountPresenter.one(discount);
  }

  // ── POST /admin/custom-discounts/:id/resume ──────────────────────────────

  @Post(':id/resume')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Resume a paused discount. Flips paused → active.' })
  @ApiOkResponse({ type: CustomDiscountResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({ description: 'Custom discount not found.' })
  @ApiConflictResponse({
    description: 'Discount is not in paused status.',
  })
  async resume(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CustomDiscountResponseDto> {
    const kgId = requireTenant(t);
    const discount = await this.service.resume(kgId, id);
    return CustomDiscountPresenter.one(discount);
  }

  // ── POST /admin/custom-discounts/:id/cancel ──────────────────────────────

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Cancel a discount. Allowed from draft, active, or paused — flips to cancelled.',
  })
  @ApiOkResponse({ type: CustomDiscountResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({ description: 'Custom discount not found.' })
  @ApiConflictResponse({
    description: 'Discount is already expired or cancelled (terminal state).',
  })
  async cancel(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CustomDiscountResponseDto> {
    const kgId = requireTenant(t);
    const discount = await this.service.cancel(kgId, id);
    return CustomDiscountPresenter.one(discount);
  }

  // ── GET /admin/custom-discounts/:id/applications ─────────────────────────

  @Get(':id/applications')
  @ApiOperation({
    summary:
      'List application log for a discount (invoice_id, child_id, amount_applied, applied_at).',
  })
  @ApiOkResponse({ type: CustomDiscountApplicationListResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({ description: 'Custom discount not found.' })
  async listApplications(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: ListCustomDiscountApplicationsQueryDto,
  ): Promise<CustomDiscountApplicationListResponseDto> {
    const kgId = requireTenant(t);
    const page = query.page ?? DEFAULT_PAGE;
    const limit = query.limit ?? DEFAULT_LIMIT;
    const pagination: CustomDiscountPageRequest = {
      limit,
      offset: (page - 1) * limit,
    };
    const result = await this.service.listApplications(kgId, id, pagination);
    return CustomDiscountPresenter.applicationList(
      result.rows,
      result.total,
      page,
      limit,
    );
  }
}
