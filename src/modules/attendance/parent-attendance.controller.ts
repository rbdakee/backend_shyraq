import {
  BadRequestException,
  Controller,
  Get,
  Inject,
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
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ChildAccessGuard } from '@/common/guards/child-access.guard';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { PendingRoleSelectGuard } from '@/common/guards/pending-role-select.guard';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';
import { AttendancePresenter } from './attendance.presenter';
import { AttendanceService } from './attendance.service';
import { AttendanceEventResponseDto } from './dto/attendance-event.response';
import { DailyStatusResponseDto } from './dto/daily-status.response';
import { ListAttendanceEventsQuery } from './dto/list-attendance-events.query';
import { ListTimelineQuery } from './dto/list-timeline.query';
import { ParentDailyStatusQuery } from './dto/parent-daily-status.query';
import { PagedTimelineResponseDto } from './dto/timeline-entry.response';
import { TimelinePresenter } from './timeline.presenter';
import { TimelineService } from './timeline.service';

const TENANT_REQUIRED = 'tenant_required';

function requireTenant(t: TenantContext): string {
  if (!t.kgId) throw new BadRequestException(TENANT_REQUIRED);
  return t.kgId;
}

/**
 * Parent-scoped read-only attendance & timeline endpoints (B8 T4).
 *
 * Guarded by ChildAccessGuard — the parent must be an approved guardian of
 * the child whose :childId appears in the URL. Matches the pattern used in
 * ScheduleParentController and MealParentController (B7).
 */
@ApiTags('Attendance (Parent)')
@ApiBearerAuth()
@Controller({ path: 'parent/children', version: '1' })
@UseGuards(JwtAuthGuard, PendingRoleSelectGuard, ChildAccessGuard)
export class ParentAttendanceController {
  constructor(
    private readonly attendanceService: AttendanceService,
    private readonly timelineService: TimelineService,
    @Inject(ClockPort) private readonly clock: ClockPort,
  ) {}

  @Get(':childId/timeline')
  @ApiOperation({
    summary:
      "Parent view of the child's timeline. Paginated, cursor-based, ordered by entry_time DESC.",
  })
  @ApiOkResponse({ type: PagedTimelineResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({
    description: 'Caller is not an approved guardian of this child.',
  })
  @ApiNotFoundResponse({ description: 'child_not_found.' })
  async getTimeline(
    @Tenant() t: TenantContext,
    @Param('childId', new ParseUUIDPipe()) childId: string,
    @Query() q: ListTimelineQuery,
  ): Promise<PagedTimelineResponseDto> {
    const kgId = requireTenant(t);
    const result = await this.timelineService.listByChild(kgId, childId, {
      limit: q.limit,
      cursor: q.cursor,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
    });
    return TimelinePresenter.paged(result.items, result.nextCursor);
  }

  @Get(':childId/attendance')
  @ApiOperation({
    summary:
      "Parent view of the child's attendance events (check-in / check-out log). Filtered by date range.",
  })
  @ApiOkResponse({ type: [AttendanceEventResponseDto] })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({
    description: 'Caller is not an approved guardian of this child.',
  })
  @ApiNotFoundResponse({ description: 'child_not_found.' })
  async getAttendance(
    @Tenant() t: TenantContext,
    @Param('childId', new ParseUUIDPipe()) childId: string,
    @Query() q: ListAttendanceEventsQuery,
  ): Promise<AttendanceEventResponseDto[]> {
    const kgId = requireTenant(t);
    const events = await this.attendanceService.listEventsByChild(
      kgId,
      childId,
      {
        from: q.from ? new Date(q.from) : undefined,
        to: q.to ? new Date(q.to) : undefined,
        limit: q.limit,
        offset: q.offset,
      },
    );
    return events.map((e) => AttendancePresenter.event(e));
  }

  @Get(':childId/daily-status')
  @ApiOperation({
    summary:
      "Get the child's daily status for the given date (defaults to today in Asia/Almaty TZ). Returns null body when no record exists for that day.",
  })
  @ApiOkResponse({
    type: DailyStatusResponseDto,
    description: 'May return null body when status not yet set.',
  })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({
    description: 'Caller is not an approved guardian of this child.',
  })
  @ApiNotFoundResponse({ description: 'child_not_found.' })
  @ApiQuery({
    name: 'date',
    required: false,
    description:
      'ISO date YYYY-MM-DD. Defaults to today in Asia/Almaty timezone.',
  })
  async getDailyStatus(
    @Tenant() t: TenantContext,
    @Param('childId', new ParseUUIDPipe()) childId: string,
    @Query() q: ParentDailyStatusQuery,
  ): Promise<DailyStatusResponseDto | null> {
    const kgId = requireTenant(t);
    const isoDate =
      q.date ??
      this.clock.now().toLocaleDateString('en-CA', { timeZone: 'Asia/Almaty' });
    const status = await this.attendanceService.getDailyStatusByChildAndDate(
      kgId,
      childId,
      isoDate,
    );
    return status ? AttendancePresenter.dailyStatus(status) : null;
  }
}
