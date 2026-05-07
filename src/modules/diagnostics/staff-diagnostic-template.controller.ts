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
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import type { JwtPayload } from '@/common/types/jwt-payload';
import { StaffMemberRepository } from '@/modules/staff/infrastructure/persistence/staff-member.repository';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';
import { ListDiagnosticTemplatesQueryDto } from './dto/list-diagnostic-templates-query.dto';
import {
  DiagnosticTemplateListResponseDto,
  DiagnosticTemplateResponseDto,
} from './dto/diagnostic-template-response.dto';
import { DiagnosticTemplatePresenter } from './diagnostic-template.presenter';
import { DiagnosticTemplateService } from './diagnostic-template.service';

const TENANT_REQUIRED = 'tenant_required';

function requireTenant(t: TenantContext): string {
  if (!t.kgId) throw new BadRequestException(TENANT_REQUIRED);
  return t.kgId;
}

/**
 * Staff read-only surface for diagnostic templates (B18).
 *
 * Non-admin staff see only templates matching their own `specialist_type`
 * (prevents a speech_therapist from viewing psychologist templates).
 * Admin callers may pass `?all=true` to bypass the filter, or omit it to
 * see all templates by default.
 */
@ApiTags('Staff / Diagnostics — Templates')
@ApiBearerAuth()
@Controller({ path: 'staff/diagnostic-templates', version: '1' })
@UseGuards(RolesGuard)
@Roles('admin', 'mentor', 'specialist')
export class StaffDiagnosticTemplateController {
  constructor(
    private readonly service: DiagnosticTemplateService,
    private readonly staffMembers: StaffMemberRepository,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'List diagnostic templates. Non-admin staff are scoped to their own specialist_type. Admin may pass ?all=true to see all.',
  })
  @ApiOkResponse({ type: DiagnosticTemplateListResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Role not allowed.' })
  async list(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Query() query: ListDiagnosticTemplatesQueryDto,
  ): Promise<DiagnosticTemplateListResponseDto> {
    const kgId = requireTenant(t);
    const isAdmin = user.role === 'admin';

    let effectiveSpecialistType = query.specialist_type;

    if (!isAdmin) {
      // Non-admin: always scope to caller's own specialist_type.
      const staffMember =
        await this.staffMembers.findActiveByUserAndKindergarten(user.sub, kgId);
      if (!staffMember) {
        throw new NotFoundException('staff_member_not_found');
      }
      // Mentors may not have a specialist_type; if so they see all active.
      effectiveSpecialistType = staffMember.specialistType ?? undefined;
    } else if (isAdmin && !query.all && !query.specialist_type) {
      // Admin without ?all=true and no explicit filter → see all (no type filter).
      effectiveSpecialistType = undefined;
    }
    // Admin with ?specialist_type= → use that filter (already set above).
    // Admin with ?all=true → clear any explicit filter.
    if (isAdmin && query.all) {
      effectiveSpecialistType = undefined;
    }

    const result = await this.service.list(kgId, {
      specialistType: effectiveSpecialistType,
      isActive: query.is_active,
      cursor: query.cursor,
      limit: query.limit ?? 20,
    });
    return DiagnosticTemplatePresenter.list(result.items, result.nextCursor);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single diagnostic template by id.' })
  @ApiOkResponse({ type: DiagnosticTemplateResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Role not allowed.' })
  @ApiNotFoundResponse({ description: 'diagnostic_template_not_found.' })
  async get(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<DiagnosticTemplateResponseDto> {
    const kgId = requireTenant(t);
    const template = await this.service.getById(kgId, id);
    return DiagnosticTemplatePresenter.one(template);
  }
}
