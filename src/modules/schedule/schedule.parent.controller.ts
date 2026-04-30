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
import { ChildAccessGuard } from '@/common/guards/child-access.guard';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { PendingRoleSelectGuard } from '@/common/guards/pending-role-select.guard';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';
import { ActivityEventResponseDto } from './dto/activity-event.response.dto';
import { ParentScheduleQuery } from './dto/week-query';
import { SchedulePresenter } from './schedule.presenter';
import { ScheduleService } from './schedule.service';

/**
 * Parent-scoped read endpoint — `/parent/children/:childId/schedule`.
 * Wrapped in `ChildAccessGuard` so callers must be approved guardians of
 * the child. The service layer additionally verifies the child exists in
 * the tenant scope.
 */
@ApiTags('Schedule (Parent)')
@ApiBearerAuth()
@Controller({ path: 'parent/children', version: '1' })
@UseGuards(JwtAuthGuard, PendingRoleSelectGuard, ChildAccessGuard)
export class ScheduleParentController {
  constructor(private readonly service: ScheduleService) {}

  @Get(':childId/schedule')
  @ApiOperation({
    summary:
      "Group schedule for the child's group within [dateFrom, dateTo). Returns all activity_events ordered by starts_at.",
  })
  @ApiOkResponse({ type: [ActivityEventResponseDto] })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({
    description: 'Caller is not an approved guardian of this child.',
  })
  @ApiNotFoundResponse({ description: 'child_not_found.' })
  async getSchedule(
    @Tenant() t: TenantContext,
    @Param('childId', new ParseUUIDPipe()) childId: string,
    @Query() q: ParentScheduleQuery,
  ): Promise<ActivityEventResponseDto[]> {
    if (!t.kgId) throw new BadRequestException('tenant_required');
    const events = await this.service.getParentScheduleForChild(
      t.kgId,
      childId,
      {
        from: new Date(q.dateFrom),
        to: new Date(q.dateTo),
      },
    );
    return events.map((e) => SchedulePresenter.event(e));
  }
}
