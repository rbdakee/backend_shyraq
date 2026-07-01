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
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { PendingRoleSelectGuard } from '@/common/guards/pending-role-select.guard';
import { RolesGuard } from '@/common/guards/roles.guard';
import type { JwtPayload } from '@/common/types/jwt-payload';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';
import { MyGroupResponseDto } from './dto/my-group.response.dto';
import { RosterPageResponseDto } from './dto/roster-child.response.dto';
import { RosterQueryDto } from './dto/roster-query.dto';
import { StaffPortalPresenter } from './staff-portal.presenter';
import { StaffPortalService } from './staff-portal.service';

const TENANT_REQUIRED = 'tenant_required';

function requireTenant(t: TenantContext): string {
  if (!t.kgId) throw new BadRequestException(TENANT_REQUIRED);
  return t.kgId;
}

/**
 * Staff-App group endpoints (read-only). Composes existing group / child /
 * attendance ports via `StaffPortalService`. Same guard chain as the other
 * staff controllers (`JwtAuthGuard → PendingRoleSelectGuard → RolesGuard`).
 *
 * `my-groups` is readable by any non-admin staff role (a specialist or
 * reception may also be assigned as a mentor of a group). The roster route is
 * mentor-only and enforces an active assignment to the requested group.
 */
@ApiTags('Staff / Portal')
@ApiBearerAuth()
@Controller({ path: 'staff', version: '1' })
@UseGuards(JwtAuthGuard, PendingRoleSelectGuard, RolesGuard)
export class StaffGroupsController {
  constructor(private readonly service: StaffPortalService) {}

  @Get('my-groups')
  @Roles('mentor', 'specialist', 'reception')
  @ApiOperation({
    summary:
      "The caller's active mentor-group assignments with display metadata " +
      '(name, age range, room, primary flag, active-children count).',
  })
  @ApiOkResponse({ type: [MyGroupResponseDto] })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller role not allowed.' })
  async myGroups(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
  ): Promise<MyGroupResponseDto[]> {
    const kgId = requireTenant(t);
    const views = await this.service.listMyGroups(kgId, user.sub);
    return StaffPortalPresenter.myGroups(views);
  }

  @Get('my-groups/:groupId/children')
  @Roles('mentor')
  @ApiOperation({
    summary:
      "Roster of active children in one of the caller's assigned groups, " +
      "with each child's day_status for today (Asia/Almaty). Opaque-cursor " +
      'paginated.',
  })
  @ApiOkResponse({ type: RosterPageResponseDto })
  @ApiBadRequestResponse({
    description: 'Validation error / malformed cursor (invalid_cursor).',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({
    description:
      'Caller role not allowed / mentor_not_assigned_to_group (caller has no ' +
      'active assignment for this group in this kindergarten).',
  })
  async groupRoster(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Param('groupId', new ParseUUIDPipe()) groupId: string,
    @Query() query: RosterQueryDto,
  ): Promise<RosterPageResponseDto> {
    const kgId = requireTenant(t);
    const page = await this.service.listGroupRoster(kgId, user.sub, groupId, {
      limit: query.limit,
      cursor: query.cursor,
    });
    return StaffPortalPresenter.rosterPage(page);
  }
}
