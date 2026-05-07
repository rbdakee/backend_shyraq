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
} from '@nestjs/swagger';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import { RolesGuard } from '@/common/guards/roles.guard';
import type { JwtPayload } from '@/common/types/jwt-payload';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';
import {
  CreateTariffAssignmentDto,
  ListTariffAssignmentsQueryDto,
  TariffAssignmentResponseDto,
  UpdateTariffAssignmentDto,
} from './dto/tariff-assignment.dto';
import { TariffAssignmentPresenter } from './tariff-assignment.presenter';
import { TariffAssignmentService } from './tariff-assignment.service';

const TENANT_REQUIRED = 'tenant_required';

function requireTenant(t: TenantContext): string {
  if (!t.kgId) throw new BadRequestException(TENANT_REQUIRED);
  return t.kgId;
}

/**
 * Admin-side CRUD over child↔tariff_plan assignments. The `assigned_by`
 * column is always taken from `req.user.sub` — body is not trusted for that
 * field.
 */
@ApiTags('Admin / Billing — Tariff Assignments')
@ApiBearerAuth()
@Controller({ path: 'admin/tariff-assignments', version: '1' })
@UseGuards(RolesGuard)
@Roles('admin')
export class AdminTariffAssignmentController {
  constructor(private readonly service: TariffAssignmentService) {}

  @Get()
  @ApiOperation({
    summary:
      'List tariff assignments (filters: child_id, tariff_plan_id, active_on).',
  })
  @ApiOkResponse({ type: [TariffAssignmentResponseDto] })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  async list(
    @Tenant() t: TenantContext,
    @Query() query: ListTariffAssignmentsQueryDto,
  ): Promise<TariffAssignmentResponseDto[]> {
    const kgId = requireTenant(t);
    const assignments = await this.service.list(kgId, {
      childId: query.child_id,
    });
    return TariffAssignmentPresenter.many(assignments);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Create a tariff assignment for a child. Server pulls assigned_by from req.user.',
  })
  @ApiCreatedResponse({ type: TariffAssignmentResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiConflictResponse({
    description: 'Overlapping assignment exists for the same child period.',
  })
  async create(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateTariffAssignmentDto,
  ): Promise<TariffAssignmentResponseDto> {
    const kgId = requireTenant(t);
    const assignment = await this.service.assign(kgId, {
      childId: dto.child_id,
      tariffPlanId: dto.tariff_plan_id,
      customAmount: dto.custom_amount ?? null,
      customReason: dto.custom_reason ?? null,
      validFrom: new Date(dto.valid_from),
      validUntil: dto.valid_until ? new Date(dto.valid_until) : null,
      assignedBy: user.sub,
    });
    return TariffAssignmentPresenter.one(assignment);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a tariff assignment by id.' })
  @ApiOkResponse({ type: TariffAssignmentResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({ description: 'Tariff assignment not found.' })
  async get(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<TariffAssignmentResponseDto> {
    const kgId = requireTenant(t);
    const assignment = await this.service.get(kgId, id);
    return TariffAssignmentPresenter.one(assignment);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update assignment (custom_amount, custom_reason, valid_until).',
  })
  @ApiOkResponse({ type: TariffAssignmentResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({ description: 'Tariff assignment not found.' })
  @ApiConflictResponse({
    description: 'New window overlaps an existing assignment.',
  })
  async update(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateTariffAssignmentDto,
  ): Promise<TariffAssignmentResponseDto> {
    const kgId = requireTenant(t);
    const assignment = await this.service.update(kgId, id, {
      customAmount: dto.custom_amount,
      customReason: dto.custom_reason,
      validUntil:
        dto.valid_until === undefined
          ? undefined
          : dto.valid_until === null
            ? null
            : new Date(dto.valid_until),
    });
    return TariffAssignmentPresenter.one(assignment);
  }

  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Close an assignment (sets valid_until to today).',
  })
  @ApiOkResponse({ type: TariffAssignmentResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({ description: 'Tariff assignment not found.' })
  async close(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<TariffAssignmentResponseDto> {
    const kgId = requireTenant(t);
    const assignment = await this.service.close(kgId, id);
    return TariffAssignmentPresenter.one(assignment);
  }
}
