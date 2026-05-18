import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
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
  ApiTooManyRequestsResponse,
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
import { AttendancePresenter } from './attendance.presenter';
import { AttendanceService } from './attendance.service';
import { AttendanceEventResponseDto } from './dto/attendance-event.response';
import { DailyStatusResponseDto } from './dto/daily-status.response';
import { ListAttendanceEventsQuery } from './dto/list-attendance-events.query';
import { ListDailyStatusQuery } from './dto/list-daily-status.query';
import { ListTimelineQuery } from './dto/list-timeline.query';
import { PatchAttendanceDto } from './dto/patch-attendance.dto';
import { PagedTimelineResponseDto } from './dto/timeline-entry.response';
import { TimelinePresenter } from './timeline.presenter';
import { TimelineService } from './timeline.service';

const TENANT_REQUIRED = 'tenant_required';

function requireTenant(t: TenantContext): string {
  if (!t.kgId) throw new BadRequestException(TENANT_REQUIRED);
  return t.kgId;
}

/**
 * Admin-scoped attendance oversight endpoints (B8 T4).
 *
 * Admin PATCH has no edit-window restriction (unlike the staff endpoint which
 * is gated to same-calendar-day in Asia/Almaty).
 */
@ApiTags('Admin / Attendance')
@ApiBearerAuth()
@Controller({ path: 'admin', version: '1' })
@UseGuards(JwtAuthGuard, PendingRoleSelectGuard, RolesGuard)
@Roles('admin', 'reception')
export class AdminAttendanceController {
  constructor(
    private readonly attendanceService: AttendanceService,
    private readonly timelineService: TimelineService,
  ) {}

  // ── Attendance events ────────────────────────────────────────────────────

  @Get('attendance-events')
  @ApiOperation({
    summary:
      'List attendance events. Filter by childId, groupId, date range, limit/offset.',
  })
  @ApiOkResponse({ type: [AttendanceEventResponseDto] })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin/reception.' })
  @ApiTooManyRequestsResponse({ description: 'Rate-limited.' })
  async listEvents(
    @Tenant() t: TenantContext,
    @Query() q: ListAttendanceEventsQuery,
  ): Promise<AttendanceEventResponseDto[]> {
    const kgId = requireTenant(t);
    const events = await this.attendanceService.listEvents(kgId, {
      childId: q.childId,
      groupId: q.groupId,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
      limit: q.limit,
      offset: q.offset,
    });
    return events.map((e) => AttendancePresenter.event(e));
  }

  @Get('attendance-events/:eventId')
  @ApiOperation({ summary: 'Get a single attendance event by id.' })
  @ApiOkResponse({ type: AttendanceEventResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin/reception.' })
  @ApiNotFoundResponse({ description: 'attendance_event_not_found.' })
  async getEvent(
    @Tenant() t: TenantContext,
    @Param('eventId', new ParseUUIDPipe()) eventId: string,
  ): Promise<AttendanceEventResponseDto> {
    const kgId = requireTenant(t);
    const event = await this.attendanceService.getEventById(kgId, eventId);
    return AttendancePresenter.event(event);
  }

  @Patch('attendance-events/:eventId')
  @ApiOperation({
    summary:
      'Admin-level patch of an attendance event. No edit-window restriction (admin can fix any historical event).',
  })
  @ApiOkResponse({ type: AttendanceEventResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin/reception.' })
  @ApiNotFoundResponse({ description: 'attendance_event_not_found.' })
  async patchEvent(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Param('eventId', new ParseUUIDPipe()) eventId: string,
    @Body() dto: PatchAttendanceDto,
  ): Promise<AttendanceEventResponseDto> {
    const kgId = requireTenant(t);
    const updated = await this.attendanceService.patchEvent(
      kgId,
      eventId,
      user.sub,
      {
        recordedAt: dto.recordedAt ? new Date(dto.recordedAt) : undefined,
        notes: dto.notes,
        pickupUserId: dto.pickupUserId,
      },
      { isAdmin: true },
    );
    return AttendancePresenter.event(updated);
  }

  // ── Daily status list ────────────────────────────────────────────────────

  @Get('daily-status')
  @ApiOperation({
    summary:
      'Paged list of child_daily_status records. Filter by childId and/or date range.',
  })
  @ApiOkResponse({ type: [DailyStatusResponseDto] })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin/reception.' })
  async listDailyStatuses(
    @Tenant() t: TenantContext,
    @Query() q: ListDailyStatusQuery,
  ): Promise<DailyStatusResponseDto[]> {
    const kgId = requireTenant(t);
    const statuses = await this.attendanceService.listDailyStatuses(kgId, {
      childId: q.childId,
      from: q.from,
      to: q.to,
      limit: q.limit,
      offset: q.offset,
    });
    return statuses.map((s) => AttendancePresenter.dailyStatus(s));
  }

  // ── Child timeline ────────────────────────────────────────────────────────

  @Get('children/:childId/timeline')
  @ApiOperation({
    summary:
      'Paginated timeline for a child. Ordered by entry_time DESC. Cursor-based paging.',
  })
  @ApiOkResponse({ type: PagedTimelineResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin/reception.' })
  @ApiNotFoundResponse({ description: 'child_not_found.' })
  async getChildTimeline(
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
}
