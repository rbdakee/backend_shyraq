import {
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
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Roles } from '@/common/decorators/roles.decorator';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { PendingRoleSelectGuard } from '@/common/guards/pending-role-select.guard';
import { RolesGuard } from '@/common/guards/roles.guard';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { KindergartenRepository } from '@/modules/kindergarten/kindergarten.repository';
import { CreateStaffDto } from './dto/create-staff.dto';
import { ListStaffQueryDto } from './dto/list-staff-query.dto';
import { StaffMemberDto } from './dto/staff-response.dto';
import { UpdateStaffDto } from './dto/update-staff.dto';
import { StaffPresenter } from './staff.presenter';
import { StaffService } from './staff.service';
import { StaffNotFoundError } from './domain/errors/staff-not-found.error';

/**
 * Admin-scoped staff endpoints. Wrapped by the global guard chain
 * (`JwtAuthGuard` → `KindergartenScopeGuard` → `RolesGuard`) and the
 * `TenantContextInterceptor` that pins `app.kindergarten_id` to the JWT
 * tenant for the duration of the handler.
 */
@ApiTags('Staff (Admin)')
@ApiBearerAuth()
@Controller({ path: 'staff', version: '1' })
@UseGuards(JwtAuthGuard, PendingRoleSelectGuard, RolesGuard)
@Roles('admin')
export class StaffController {
  constructor(
    private readonly service: StaffService,
    private readonly kindergartens: KindergartenRepository,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List staff in the caller’s kindergarten.' })
  @ApiOkResponse({ type: [StaffMemberDto] })
  async list(
    @Tenant() tenant: TenantContext,
    @Query() query: ListStaffQueryDto,
  ): Promise<StaffMemberDto[]> {
    if (!tenant.kgId) throw new StaffNotFoundError('<no-tenant>');
    const rows = await this.service.list(tenant.kgId, {
      role: query.role,
      isActive: query.is_active,
      specialistType: query.specialist_type,
      archived: query.archived,
      search: query.search,
    });
    return rows.map((r) => StaffPresenter.staff(r));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a staff member by id.' })
  @ApiOkResponse({ type: StaffMemberDto })
  async getOne(
    @Tenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<StaffMemberDto> {
    if (!tenant.kgId) throw new StaffNotFoundError(id);
    const row = await this.service.getById(tenant.kgId, id);
    return StaffPresenter.staff(row);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a staff member.' })
  @ApiOkResponse({ type: StaffMemberDto })
  async create(
    @Tenant() tenant: TenantContext,
    @Body() dto: CreateStaffDto,
  ): Promise<StaffMemberDto> {
    if (!tenant.kgId) throw new StaffNotFoundError('<no-tenant>');
    const kg = await this.kindergartens.findById(tenant.kgId);
    const row = await this.service.create(
      tenant.kgId,
      {
        fullName: dto.full_name,
        phone: dto.phone,
        role: dto.role,
        specialistType: dto.specialist_type ?? null,
        hiredAt: dto.hired_at ? new Date(dto.hired_at) : null,
      },
      { kindergartenName: kg?.name ?? '' },
    );
    return StaffPresenter.staff(row);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a staff member.' })
  @ApiOkResponse({ type: StaffMemberDto })
  async update(
    @Tenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateStaffDto,
  ): Promise<StaffMemberDto> {
    if (!tenant.kgId) throw new StaffNotFoundError(id);
    const patch: Parameters<StaffService['update']>[2] = {};
    if (dto.full_name !== undefined) patch.fullName = dto.full_name;
    if (dto.role !== undefined) patch.role = dto.role;
    if (Object.prototype.hasOwnProperty.call(dto, 'specialist_type')) {
      patch.specialistType = dto.specialist_type ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(dto, 'hired_at')) {
      patch.hiredAt = dto.hired_at ? new Date(dto.hired_at) : null;
    }
    if (Object.prototype.hasOwnProperty.call(dto, 'fired_at')) {
      patch.firedAt = dto.fired_at ? new Date(dto.fired_at) : null;
    }
    const row = await this.service.update(tenant.kgId, id, patch);
    return StaffPresenter.staff(row);
  }

  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Deactivate a staff member (idempotent).' })
  @ApiOkResponse({ type: StaffMemberDto })
  async deactivate(
    @Tenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<StaffMemberDto> {
    if (!tenant.kgId) throw new StaffNotFoundError(id);
    const row = await this.service.deactivate(tenant.kgId, id);
    return StaffPresenter.staff(row);
  }

  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Activate a staff member (idempotent).' })
  @ApiOkResponse({ type: StaffMemberDto })
  async activate(
    @Tenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<StaffMemberDto> {
    if (!tenant.kgId) throw new StaffNotFoundError(id);
    const row = await this.service.activate(tenant.kgId, id);
    return StaffPresenter.staff(row);
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Archive a staff member (idempotent).' })
  @ApiOkResponse({ type: StaffMemberDto })
  async archive(
    @Tenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<StaffMemberDto> {
    if (!tenant.kgId) throw new StaffNotFoundError(id);
    const row = await this.service.archive(tenant.kgId, id);
    return StaffPresenter.staff(row);
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Restore an archived staff member (idempotent).' })
  @ApiOkResponse({ type: StaffMemberDto })
  async restore(
    @Tenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<StaffMemberDto> {
    if (!tenant.kgId) throw new StaffNotFoundError(id);
    const row = await this.service.restore(tenant.kgId, id);
    return StaffPresenter.staff(row);
  }
}
