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
import { Roles } from '@/common/decorators/roles.decorator';
import { RolesGuard } from '@/common/guards/roles.guard';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import type { JwtPayload } from '@/common/types/jwt-payload';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';
import { CreateDiagnosticTemplateDto } from './dto/create-diagnostic-template.dto';
import { UpdateDiagnosticTemplateDto } from './dto/update-diagnostic-template.dto';
import { ListDiagnosticTemplatesQueryDto } from './dto/list-diagnostic-templates-query.dto';
import {
  DiagnosticTemplateListResponseDto,
  DiagnosticTemplateResponseDto,
} from './dto/diagnostic-template-response.dto';
import { DiagnosticTemplatePresenter } from './diagnostic-template.presenter';
import { DiagnosticTemplateService } from './diagnostic-template.service';
import { TemplateSchema } from './domain/schema-validators';

const TENANT_REQUIRED = 'tenant_required';

function requireTenant(t: TenantContext): string {
  if (!t.kgId) throw new BadRequestException(TENANT_REQUIRED);
  return t.kgId;
}

/**
 * Admin CRUD over per-kindergarten diagnostic templates (B18).
 *
 * All endpoints require role=admin. Tenant scope is enforced by the global
 * `KindergartenScopeGuard` + `TenantContextInterceptor`; `RolesGuard` layers
 * admin-role check on top.
 */
@ApiTags('Admin / Diagnostics — Templates')
@ApiBearerAuth()
@Controller({ path: 'admin/diagnostic-templates', version: '1' })
@UseGuards(RolesGuard)
@Roles('admin')
export class AdminDiagnosticTemplateController {
  constructor(private readonly service: DiagnosticTemplateService) {}

  @Get()
  @ApiOperation({
    summary:
      'List diagnostic templates. Filters: specialist_type, is_active. Cursor paginated.',
  })
  @ApiOkResponse({ type: DiagnosticTemplateListResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  async list(
    @Tenant() t: TenantContext,
    @Query() query: ListDiagnosticTemplatesQueryDto,
  ): Promise<DiagnosticTemplateListResponseDto> {
    const kgId = requireTenant(t);
    const result = await this.service.list(kgId, {
      specialistType: query.specialist_type,
      isActive: query.is_active,
      cursor: query.cursor,
      limit: query.limit ?? 20,
    });
    return DiagnosticTemplatePresenter.list(result.items, result.nextCursor);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a diagnostic template.' })
  @ApiCreatedResponse({ type: DiagnosticTemplateResponseDto })
  @ApiBadRequestResponse({
    description: 'Validation error / invalid schema shape.',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  async create(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateDiagnosticTemplateDto,
  ): Promise<DiagnosticTemplateResponseDto> {
    const kgId = requireTenant(t);
    const staffMember = await this.service.findStaffMemberByUserIdOrThrow(
      kgId,
      user.sub,
    );
    const template = await this.service.create(
      kgId,
      {
        specialistType: dto.specialist_type,
        name: dto.name,
        description: dto.description ?? null,
        schema: dto.schema as TemplateSchema,
      },
      staffMember.id,
    );
    return DiagnosticTemplatePresenter.one(template);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single diagnostic template by id.' })
  @ApiOkResponse({ type: DiagnosticTemplateResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({ description: 'diagnostic_template_not_found.' })
  async get(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<DiagnosticTemplateResponseDto> {
    const kgId = requireTenant(t);
    const template = await this.service.getById(kgId, id);
    return DiagnosticTemplatePresenter.one(template);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Update a diagnostic template (partial). Bumps version on schema change. ' +
      'Schema PATCH on a template with existing entries → 409 template_has_entries.',
  })
  @ApiOkResponse({ type: DiagnosticTemplateResponseDto })
  @ApiBadRequestResponse({
    description: 'Validation error / invalid schema shape.',
  })
  @ApiConflictResponse({
    description:
      'template_has_entries — schema is pinned because entries reference this template.',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({ description: 'diagnostic_template_not_found.' })
  async update(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateDiagnosticTemplateDto,
  ): Promise<DiagnosticTemplateResponseDto> {
    const kgId = requireTenant(t);
    const template = await this.service.update(kgId, id, {
      name: dto.name,
      description: dto.description,
      schema:
        dto.schema !== undefined ? (dto.schema as TemplateSchema) : undefined,
    });
    return DiagnosticTemplatePresenter.one(template);
  }

  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Deactivate a diagnostic template (sets is_active=false).',
  })
  @ApiOkResponse({ type: DiagnosticTemplateResponseDto })
  @ApiConflictResponse({ description: 'already_inactive.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({ description: 'diagnostic_template_not_found.' })
  async deactivate(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<DiagnosticTemplateResponseDto> {
    const kgId = requireTenant(t);
    const template = await this.service.deactivate(kgId, id);
    return DiagnosticTemplatePresenter.one(template);
  }
}
