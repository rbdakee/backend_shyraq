import {
  BadRequestException,
  Body,
  Controller,
  Delete,
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
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Roles } from '@/common/decorators/roles.decorator';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { PendingRoleSelectGuard } from '@/common/guards/pending-role-select.guard';
import { RolesGuard } from '@/common/guards/roles.guard';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { CreateSpecialistTypeDto } from './dto/create-specialist-type.dto';
import { ListSpecialistTypesQueryDto } from './dto/list-specialist-types-query.dto';
import { SpecialistTypeResponseDto } from './dto/specialist-type-response.dto';
import { UpdateSpecialistTypeDto } from './dto/update-specialist-type.dto';
import { SpecialistTypePresenter } from './specialist-type.presenter';
import { SpecialistTypeService } from './specialist-type.service';

function requireTenant(t: TenantContext): string {
  if (!t.kgId) throw new BadRequestException({ code: 'tenant_required' });
  return t.kgId;
}

/**
 * Admin-managed specialist-type directory (N12 — BACKEND_NEEDINGS_HANDOFF).
 * kg-scoped; `RolesGuard` enforces `admin` on top of the global JWT + tenant
 * guards. Labels (`name_i18n`) are served from here so the frontend stops
 * hard-coding the specialist i18n map.
 */
@ApiTags('Specialist Types (Admin)')
@ApiBearerAuth()
@Controller({ path: 'admin/specialist-types', version: '1' })
@UseGuards(JwtAuthGuard, PendingRoleSelectGuard, RolesGuard)
@Roles('admin')
export class AdminSpecialistTypeController {
  constructor(private readonly service: SpecialistTypeService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'List the kindergarten specialist-type directory.',
    description:
      'Active rows only by default (the staff/diagnostics dropdown set). Pass `include_inactive=true` for the full CRUD screen. Ordered by sort_order, then code.',
  })
  @ApiOkResponse({ type: [SpecialistTypeResponseDto] })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not an admin.' })
  async list(
    @Tenant() t: TenantContext,
    @Query() query: ListSpecialistTypesQueryDto,
  ): Promise<SpecialistTypeResponseDto[]> {
    const kgId = requireTenant(t);
    const rows = await this.service.list(kgId, {
      includeInactive: query.include_inactive,
    });
    return SpecialistTypePresenter.many(rows);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a custom specialist type.' })
  @ApiCreatedResponse({ type: SpecialistTypeResponseDto })
  @ApiBadRequestResponse({
    description:
      'Validation failed (specialist_type_code_invalid / specialist_type_name_required).',
  })
  @ApiConflictResponse({
    description: 'specialist_type_code_taken — code already exists in this kg.',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not an admin.' })
  async create(
    @Tenant() t: TenantContext,
    @Body() dto: CreateSpecialistTypeDto,
  ): Promise<SpecialistTypeResponseDto> {
    const kgId = requireTenant(t);
    const created = await this.service.create(kgId, {
      code: dto.code,
      nameI18n: dto.name_i18n as { ru: string; kk: string },
      isActive: dto.is_active,
      sortOrder: dto.sort_order,
    });
    return SpecialistTypePresenter.one(created);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update a specialist type (rename / (de)activate / reorder).',
    description:
      'System rows can be renamed, deactivated and reordered — but not deleted. `code` is immutable.',
  })
  @ApiOkResponse({ type: SpecialistTypeResponseDto })
  @ApiBadRequestResponse({ description: 'Validation failed.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not an admin.' })
  @ApiNotFoundResponse({ description: 'specialist_type_not_found.' })
  async update(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateSpecialistTypeDto,
  ): Promise<SpecialistTypeResponseDto> {
    const kgId = requireTenant(t);
    const updated = await this.service.update(kgId, id, {
      ...(dto.name_i18n !== undefined
        ? { nameI18n: dto.name_i18n as { ru: string; kk: string } }
        : {}),
      ...(dto.is_active !== undefined ? { isActive: dto.is_active } : {}),
      ...(dto.sort_order !== undefined ? { sortOrder: dto.sort_order } : {}),
    });
    return SpecialistTypePresenter.one(updated);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a custom specialist type.',
    description:
      'System rows are permanent (409 specialist_type_system_immutable — deactivate instead). A code still referenced by staff/diagnostics is blocked (409 specialist_type_in_use).',
  })
  @ApiNoContentResponse({ description: 'Deleted.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not an admin.' })
  @ApiNotFoundResponse({ description: 'specialist_type_not_found.' })
  @ApiConflictResponse({
    description:
      'specialist_type_system_immutable (system row) / specialist_type_in_use (still referenced).',
  })
  async delete(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    const kgId = requireTenant(t);
    await this.service.delete(kgId, id);
  }
}
