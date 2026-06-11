import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { Roles } from '@/common/decorators/roles.decorator';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { PendingRoleSelectGuard } from '@/common/guards/pending-role-select.guard';
import { RolesGuard } from '@/common/guards/roles.guard';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';
import { ActivityEventResponseDto } from './dto/activity-event.response.dto';
import { CancelEventDto } from './dto/cancel-event.dto';
import { ScheduleWeekResponseDto } from './dto/schedule-week.response.dto';
import { StaffTodayQuery, StaffWeekQuery } from './dto/week-query';
import { SchedulePresenter } from './schedule.presenter';
import { ScheduleService } from './schedule.service';

const TENANT_REQUIRED = 'tenant_required';

function requireTenant(t: TenantContext): string {
  if (!t.kgId) throw new BadRequestException(TENANT_REQUIRED);
  return t.kgId;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Staff-scoped endpoints — mentor reads own group's schedule, runs the
 * activity_event state machine. Roles allowed: mentor + specialist +
 * reception (any non-admin staff role can read; state-changes mounted
 * with the same chain — controllers use class-level @Roles).
 */
@ApiTags('Staff / Schedule')
@ApiBearerAuth()
@Controller({ path: 'staff/schedule', version: '1' })
@UseGuards(JwtAuthGuard, PendingRoleSelectGuard, RolesGuard)
@Roles('mentor', 'specialist', 'reception')
export class ScheduleStaffController {
  constructor(
    private readonly service: ScheduleService,
    @Inject(ClockPort) private readonly clock: ClockPort,
  ) {}

  @Get('today')
  @ApiOperation({ summary: "Today's events for the requested group." })
  @ApiOkResponse({ type: [ActivityEventResponseDto] })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller role not allowed.' })
  async today(
    @Tenant() t: TenantContext,
    @Query() q: StaffTodayQuery,
  ): Promise<ActivityEventResponseDto[]> {
    const kgId = requireTenant(t);
    const events = await this.service.getGroupToday(kgId, q.groupId);
    const names = await this.service.resolveLocationNames(kgId, events);
    return SchedulePresenter.events(events, names);
  }

  @Get('week')
  @ApiOperation({
    summary:
      'Week-grouped schedule for the requested group. weekStart defaults to Monday of this week (UTC).',
  })
  @ApiOkResponse({ type: ScheduleWeekResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller role not allowed.' })
  async week(
    @Tenant() t: TenantContext,
    @Query() q: StaffWeekQuery,
  ): Promise<ScheduleWeekResponseDto> {
    const kgId = requireTenant(t);
    const start = q.weekStart ? new Date(q.weekStart) : this.clock.now();
    const view = await this.service.getGroupWeek(kgId, q.groupId, start);
    const names = await this.service.resolveLocationNames(kgId, view.events);
    return groupEventsByDay(
      view.weekStart,
      SchedulePresenter.events(view.events, names),
    );
  }

  @Post('activity-events/:id/start')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Mark event as in_progress (state machine: scheduled → in_progress).',
  })
  @ApiOkResponse({ type: ActivityEventResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller role not allowed.' })
  @ApiNotFoundResponse({ description: 'activity_event_not_found.' })
  @ApiConflictResponse({ description: 'invalid_activity_event_transition.' })
  @ApiUnprocessableEntityResponse({
    description: 'Domain invariant violation.',
  })
  @ApiTooManyRequestsResponse({ description: 'Rate-limited.' })
  async start(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ActivityEventResponseDto> {
    const kgId = requireTenant(t);
    const updated = await this.service.startEvent(kgId, id);
    const name = await this.service.resolveLocationName(kgId, updated);
    return SchedulePresenter.event(updated, name);
  }

  @Post('activity-events/:id/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Mark event as completed (state machine: in_progress → completed).',
  })
  @ApiOkResponse({ type: ActivityEventResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller role not allowed.' })
  @ApiNotFoundResponse({ description: 'activity_event_not_found.' })
  @ApiConflictResponse({ description: 'invalid_activity_event_transition.' })
  async complete(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ActivityEventResponseDto> {
    const kgId = requireTenant(t);
    const updated = await this.service.completeEvent(kgId, id);
    const name = await this.service.resolveLocationName(kgId, updated);
    return SchedulePresenter.event(updated, name);
  }

  @Post('activity-events/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark event as cancelled with reason.' })
  @ApiOkResponse({ type: ActivityEventResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller role not allowed.' })
  @ApiNotFoundResponse({ description: 'activity_event_not_found.' })
  @ApiConflictResponse({ description: 'invalid_activity_event_transition.' })
  async cancel(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CancelEventDto,
  ): Promise<ActivityEventResponseDto> {
    const kgId = requireTenant(t);
    const updated = await this.service.cancelEvent(kgId, id, dto.reason);
    const name = await this.service.resolveLocationName(kgId, updated);
    return SchedulePresenter.event(updated, name);
  }
}

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function groupEventsByDay(
  weekStart: Date,
  events: ActivityEventResponseDto[],
): ScheduleWeekResponseDto {
  const days = DAYS.map((day, idx) => {
    const date = new Date(weekStart.getTime() + idx * DAY_MS);
    const dateStr = toIsoDate(date);
    const dayEvents = events.filter((e) => e.startsAt.slice(0, 10) === dateStr);
    return {
      dayOfWeek: day,
      date: dateStr,
      events: dayEvents,
    };
  });
  return { weekStart: toIsoDate(weekStart), days };
}
