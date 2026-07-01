import {
  BadRequestException,
  Controller,
  Get,
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
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { PendingRoleSelectGuard } from '@/common/guards/pending-role-select.guard';
import { RolesGuard } from '@/common/guards/roles.guard';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';
import { ChildCardResponseDto } from './dto/child-card.response.dto';
import { RosterPageResponseDto } from './dto/roster-child.response.dto';
import { SpecialistChildrenQueryDto } from './dto/specialist-children-query.dto';
import { StaffPortalPresenter } from './staff-portal.presenter';
import { StaffPortalService } from './staff-portal.service';

const TENANT_REQUIRED = 'tenant_required';

function requireTenant(t: TenantContext): string {
  if (!t.kgId) throw new BadRequestException(TENANT_REQUIRED);
  return t.kgId;
}

/**
 * Staff-App child endpoints (read-only). Same guard chain as the other staff
 * controllers (`JwtAuthGuard → PendingRoleSelectGuard → RolesGuard`).
 *
 *   - `GET /staff/children` — specialist child-picker for diagnostics
 *     (kindergarten-wide active children, specialist-only).
 *   - `GET /staff/children/:id` — full child card, readable by any staff role
 *     of the child's kindergarten.
 */
@ApiTags('Staff / Portal')
@ApiBearerAuth()
@Controller({ path: 'staff', version: '1' })
@UseGuards(JwtAuthGuard, PendingRoleSelectGuard, RolesGuard)
export class StaffChildController {
  constructor(private readonly service: StaffPortalService) {}

  @Get('children')
  @Roles('specialist')
  @ApiOperation({
    summary:
      "Active children of the caller's kindergarten for specialist " +
      'diagnostics child-picking. Opaque-cursor paginated. The ' +
      '`specialist_scope` flag is retained per the mobile contract; the route ' +
      'is specialist-only.',
  })
  @ApiOkResponse({ type: RosterPageResponseDto })
  @ApiBadRequestResponse({
    description: 'Validation error / malformed cursor (invalid_cursor).',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller role not allowed.' })
  async specialistChildren(
    @Tenant() t: TenantContext,
    @Query() query: SpecialistChildrenQueryDto,
  ): Promise<RosterPageResponseDto> {
    const kgId = requireTenant(t);
    const page = await this.service.listSpecialistChildren(kgId, {
      limit: query.limit,
      cursor: query.cursor,
    });
    return StaffPortalPresenter.rosterPage(page);
  }

  @Get('children/:id')
  @Roles('mentor', 'specialist', 'reception')
  @ApiOperation({
    summary:
      'Full child card (group, allergies, medical notes, approved guardians). ' +
      "Kindergarten-scoped — readable by any staff role of the child's " +
      'kindergarten.',
  })
  @ApiOkResponse({ type: ChildCardResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller role not allowed.' })
  @ApiNotFoundResponse({
    description: "child_not_found (child is not in the caller's kindergarten).",
  })
  async childCard(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ChildCardResponseDto> {
    const kgId = requireTenant(t);
    const view = await this.service.getChildCard(kgId, id);
    return StaffPortalPresenter.childCard(view);
  }
}
