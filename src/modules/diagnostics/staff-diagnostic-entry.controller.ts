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
import { CreateDiagnosticEntryDto } from './dto/create-diagnostic-entry.dto';
import { UpdateDiagnosticEntryDto } from './dto/update-diagnostic-entry.dto';
import { ListDiagnosticEntriesQueryDto } from './dto/list-diagnostic-entries-query.dto';
import {
  DiagnosticEntryListResponseDto,
  DiagnosticEntryResponseDto,
} from './dto/diagnostic-entry-response.dto';
import {
  DiagnosticEntryPresenter,
  TemplateLookup,
} from './diagnostic-entry.presenter';
import { DiagnosticEntryService } from './diagnostic-entry.service';
import { DiagnosticTemplateService } from './diagnostic-template.service';
import { DiagnosticEntry } from './domain/entities/diagnostic-entry.entity';

const TENANT_REQUIRED = 'tenant_required';

function requireTenant(t: TenantContext): string {
  if (!t.kgId) throw new BadRequestException(TENANT_REQUIRED);
  return t.kgId;
}

/**
 * Build a template name+version map for the supplied entries with ONE
 * batch SELECT (B22b T5 / B18 M6 closure). Previously this fanned out
 * N parallel `findById` round-trips, which scaled linearly with page
 * size — at limit=100 that's a 100x amplification for a page load.
 *
 * `DiagnosticTemplateService.listByIds` issues a single
 * `WHERE id = ANY($2)` keyed by the de-duplicated template ids; missing
 * templates (deleted/cross-tenant) surface as `{ name: '', version: 0 }`
 * fallback entries so the list response stays intact instead of failing
 * mid-render.
 */
async function buildTemplateLookup(
  kgId: string,
  entries: DiagnosticEntry[],
  templateService: DiagnosticTemplateService,
): Promise<Map<string, TemplateLookup>> {
  const uniqueTemplateIds = [...new Set(entries.map((e) => e.templateId))];
  const lookup = new Map<string, TemplateLookup>();
  if (uniqueTemplateIds.length === 0) {
    return lookup;
  }
  const templates = await templateService.listByIds(kgId, uniqueTemplateIds);
  for (const tid of uniqueTemplateIds) {
    const tpl = templates.get(tid);
    lookup.set(
      tid,
      tpl ? { name: tpl.name, version: tpl.version } : { name: '', version: 0 },
    );
  }
  return lookup;
}

/**
 * Staff CRUD for diagnostic entries (B18).
 *
 * Only `admin` and `specialist` roles may create / update entries (mentor
 * cannot author diagnostic entries per BP §8.3 — mentor writes progress
 * notes instead).
 */
@ApiTags('Staff / Diagnostics — Entries')
@ApiBearerAuth()
@Controller({ path: 'staff/diagnostic-entries', version: '1' })
@UseGuards(RolesGuard)
@Roles('admin', 'specialist')
export class StaffDiagnosticEntryController {
  constructor(
    private readonly service: DiagnosticEntryService,
    private readonly templateService: DiagnosticTemplateService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'List diagnostic entries. Filters: child_id, specialist_id, template_id, from, to. Cursor paginated.',
  })
  @ApiOkResponse({ type: DiagnosticEntryListResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Role not allowed.' })
  async list(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Query() query: ListDiagnosticEntriesQueryDto,
  ): Promise<DiagnosticEntryListResponseDto> {
    const kgId = requireTenant(t);
    // Non-admin callers always see their own entries — `specialist_id` query
    // param is admin-only. We force the filter to caller's staff_member_id
    // for non-admins (per docs/endpoints.md §3.10).
    const isAdmin = user.role === 'admin';
    let effectiveSpecialistId: string | undefined = query.specialist_id;
    if (!isAdmin) {
      const staffMember = await this.service.findStaffMemberByUserIdOrThrow(
        kgId,
        user.sub,
      );
      effectiveSpecialistId = staffMember.id;
    }
    const result = await this.service.listByKgFiltered(kgId, {
      childId: query.child_id,
      specialistId: effectiveSpecialistId,
      templateId: query.template_id,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      cursor: query.cursor,
      limit: query.limit ?? 20,
    });
    const lookup = await buildTemplateLookup(
      kgId,
      result.items,
      this.templateService,
    );
    const specialists = await this.service.resolveSpecialists(
      kgId,
      result.items,
    );
    return DiagnosticEntryPresenter.list(
      result.items,
      result.nextCursor,
      lookup,
      specialists,
    );
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a diagnostic entry for a child.' })
  @ApiCreatedResponse({ type: DiagnosticEntryResponseDto })
  @ApiBadRequestResponse({
    description:
      'Validation error / diagnostic_entry_data_invalid / assessment_date_in_future.',
  })
  @ApiConflictResponse({ description: 'diagnostic_template_inactive.' })
  @ApiNotFoundResponse({
    description: 'diagnostic_template_not_found / staff_member_not_found.',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Role not allowed.' })
  async create(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateDiagnosticEntryDto,
  ): Promise<DiagnosticEntryResponseDto> {
    const kgId = requireTenant(t);
    const staffMember = await this.service.findStaffMemberByUserIdOrThrow(
      kgId,
      user.sub,
    );
    const entry = await this.service.create(kgId, {
      childId: dto.child_id,
      templateId: dto.template_id,
      specialistId: staffMember.id,
      assessmentDate: new Date(dto.assessment_date),
      data: dto.data,
      summary: dto.summary ?? null,
      recommendations: dto.recommendations ?? null,
      attachments: dto.attachments ?? [],
    });
    const template = await this.templateService.getById(kgId, entry.templateId);
    const lookup = new Map<string, TemplateLookup>([
      [entry.templateId, { name: template.name, version: template.version }],
    ]);
    const specialists = await this.service.resolveSpecialists(kgId, [entry]);
    return DiagnosticEntryPresenter.one(
      entry,
      lookup,
      specialists.get(entry.specialistId) ?? null,
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single diagnostic entry by id.' })
  @ApiOkResponse({ type: DiagnosticEntryResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Role not allowed.' })
  @ApiNotFoundResponse({ description: 'diagnostic_entry_not_found.' })
  async get(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<DiagnosticEntryResponseDto> {
    const kgId = requireTenant(t);
    const entry = await this.service.getById(kgId, id);
    const template = await this.templateService.getById(kgId, entry.templateId);
    const lookup = new Map<string, TemplateLookup>([
      [entry.templateId, { name: template.name, version: template.version }],
    ]);
    const specialists = await this.service.resolveSpecialists(kgId, [entry]);
    return DiagnosticEntryPresenter.one(
      entry,
      lookup,
      specialists.get(entry.specialistId) ?? null,
    );
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Update a diagnostic entry (partial). Author-only unless caller is admin.',
  })
  @ApiOkResponse({ type: DiagnosticEntryResponseDto })
  @ApiBadRequestResponse({
    description: 'Validation error / diagnostic_entry_data_invalid.',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({
    description:
      'Role not allowed / diagnostic_entry_not_authored_by_you (non-admin).',
  })
  @ApiNotFoundResponse({ description: 'diagnostic_entry_not_found.' })
  async update(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateDiagnosticEntryDto,
  ): Promise<DiagnosticEntryResponseDto> {
    const kgId = requireTenant(t);
    const staffMember = await this.service.findStaffMemberByUserIdOrThrow(
      kgId,
      user.sub,
    );
    // Admin callers bypass the author check by passing their own staff id as
    // the expected author. The service will assert authoredBy(staffMemberId);
    // to let admins through we pass the entry's actual specialist_id when the
    // caller is admin — we fetch the entry first to obtain it.
    const isAdmin = user.role === 'admin';
    let callerStaffMemberId = staffMember.id;
    if (isAdmin) {
      const existing = await this.service.getById(kgId, id);
      callerStaffMemberId = existing.specialistId;
    }
    const entry = await this.service.update(
      kgId,
      id,
      callerStaffMemberId,
      // B22a T7 — pass the caller's `users.id` so the service can stamp
      // `last_modified_by_user_id` (admin-bypass audit trail). Even when
      // admin overrides the author check, this column captures the
      // actual identity of the editor.
      user.sub,
      {
        data: dto.data,
        summary: dto.summary,
        recommendations: dto.recommendations,
        attachments: dto.attachments,
      },
    );
    const template = await this.templateService.getById(kgId, entry.templateId);
    const lookup = new Map<string, TemplateLookup>([
      [entry.templateId, { name: template.name, version: template.version }],
    ]);
    const specialists = await this.service.resolveSpecialists(kgId, [entry]);
    return DiagnosticEntryPresenter.one(
      entry,
      lookup,
      specialists.get(entry.specialistId) ?? null,
    );
  }
}
