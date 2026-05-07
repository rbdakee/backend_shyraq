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
  ApiCreatedResponse,
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
  CreateTariffPlanDto,
  ListTariffPlansQueryDto,
  TariffPlanResponseDto,
  UpdateTariffPlanDto,
} from './dto/tariff-plan.dto';
import { TariffPlanPresenter } from './tariff-plan.presenter';
import { TariffPlanService } from './tariff-plan.service';

const TENANT_REQUIRED = 'tenant_required';

function requireTenant(t: TenantContext): string {
  if (!t.kgId) throw new BadRequestException(TENANT_REQUIRED);
  return t.kgId;
}

/**
 * Admin-side CRUD over the per-kindergarten tariff catalogue (B13). Tenant
 * scope is enforced by the global `KindergartenScopeGuard` +
 * `TenantContextInterceptor`; this controller layers `RolesGuard` + admin
 * role on top.
 */
@ApiTags('Admin / Billing — Tariff Plans')
@ApiBearerAuth()
@Controller({ path: 'admin/tariff-plans', version: '1' })
@UseGuards(RolesGuard)
@Roles('admin')
export class AdminTariffPlanController {
  constructor(private readonly service: TariffPlanService) {}

  @Get()
  @ApiOperation({
    summary: 'List tariff plans (filters: is_active, tariff_type, group_id).',
  })
  @ApiOkResponse({ type: [TariffPlanResponseDto] })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  async list(
    @Tenant() t: TenantContext,
    @Query() query: ListTariffPlansQueryDto,
  ): Promise<TariffPlanResponseDto[]> {
    const kgId = requireTenant(t);
    const plans = await this.service.list(kgId, {
      isActive: query.is_active,
      tariffType: query.tariff_type,
      groupId: query.group_id,
    });
    return TariffPlanPresenter.many(plans);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a tariff plan.' })
  @ApiCreatedResponse({ type: TariffPlanResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  async create(
    @Tenant() t: TenantContext,
    @Body() dto: CreateTariffPlanDto,
  ): Promise<TariffPlanResponseDto> {
    const kgId = requireTenant(t);
    const plan = await this.service.create(kgId, {
      name: dto.name,
      description: dto.description,
      tariffType: dto.tariff_type,
      amount: dto.amount,
      appliesTo: dto.applies_to,
      groupId: dto.group_id ?? null,
      ageMinMonths: dto.age_min_months ?? null,
      ageMaxMonths: dto.age_max_months ?? null,
      validFrom: new Date(dto.valid_from),
      validUntil: dto.valid_until ? new Date(dto.valid_until) : null,
      discountRules: dto.discount_rules,
    });
    return TariffPlanPresenter.one(plan);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single tariff plan by id.' })
  @ApiOkResponse({ type: TariffPlanResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({ description: 'Tariff plan not found.' })
  async get(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<TariffPlanResponseDto> {
    const kgId = requireTenant(t);
    const plan = await this.service.get(kgId, id);
    return TariffPlanPresenter.one(plan);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update tariff plan (partial).' })
  @ApiOkResponse({ type: TariffPlanResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({ description: 'Tariff plan not found.' })
  async update(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateTariffPlanDto,
  ): Promise<TariffPlanResponseDto> {
    const kgId = requireTenant(t);
    const plan = await this.service.update(kgId, id, {
      name: dto.name,
      description: dto.description,
      amount: dto.amount,
      discountRules: dto.discount_rules,
      validUntil:
        dto.valid_until === undefined
          ? undefined
          : dto.valid_until === null
            ? null
            : new Date(dto.valid_until),
    });
    return TariffPlanPresenter.one(plan);
  }

  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Deactivate a tariff plan (sets is_active=false).',
  })
  @ApiOkResponse({ type: TariffPlanResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({ description: 'Tariff plan not found.' })
  async deactivate(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<TariffPlanResponseDto> {
    const kgId = requireTenant(t);
    const plan = await this.service.deactivate(kgId, id);
    return TariffPlanPresenter.one(plan);
  }
}
