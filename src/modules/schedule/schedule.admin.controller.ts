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
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { Roles } from '@/common/decorators/roles.decorator';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { PendingRoleSelectGuard } from '@/common/guards/pending-role-select.guard';
import { RolesGuard } from '@/common/guards/roles.guard';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';
import { ActivityEventResponseDto } from './dto/activity-event.response.dto';
import { CopyWeekDto } from './dto/copy-week.dto';
import { CreateActivityEventDto } from './dto/create-activity-event.dto';
import { CreateScheduleTemplateDto } from './dto/create-schedule-template.dto';
import { CreateSlotDto } from './dto/create-slot.dto';
import { ListActivityEventsQuery } from './dto/list-activity-events.query';
import { ListSchedulesTemplatesQuery } from './dto/list-templates.query';
import { ListWeekSnapshotsQuery } from './dto/list-week-snapshots.query';
import {
  RebuildWeekSnapshotsDto,
  RematerializeSummaryDto,
} from './dto/rebuild-week-snapshots.dto';
import { ScheduleTemplateResponseDto } from './dto/schedule-template.response.dto';
import { UpdateActivityEventDto } from './dto/update-activity-event.dto';
import { UpdateScheduleTemplateDto } from './dto/update-schedule-template.dto';
import { UpdateSlotDto } from './dto/update-slot.dto';
import {
  ScheduleWeekSnapshotResponseDto,
  WeekCopySummaryDto,
} from './dto/week-snapshot.response.dto';
import { SchedulePresenter } from './schedule.presenter';
import { ScheduleService } from './schedule.service';

const TENANT_REQUIRED = 'tenant_required';

function requireTenant(t: TenantContext): string {
  if (!t.kgId) throw new BadRequestException(TENANT_REQUIRED);
  return t.kgId;
}

/**
 * Admin-scoped endpoints for B7 schedule. Role-enforced via @Roles('admin');
 * tenant resolved by the global KindergartenScopeGuard +
 * TenantContextInterceptor pipeline.
 */
@ApiTags('Admin / Schedule')
@ApiBearerAuth()
@Controller({ path: 'admin/schedule', version: '1' })
@UseGuards(JwtAuthGuard, PendingRoleSelectGuard, RolesGuard)
@Roles('admin')
export class ScheduleAdminController {
  constructor(private readonly service: ScheduleService) {}

  // ── Templates ────────────────────────────────────────────────────────────

  @Get('templates')
  @ApiOperation({ summary: 'List schedule templates of this kindergarten.' })
  @ApiOkResponse({ type: [ScheduleTemplateResponseDto] })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiTooManyRequestsResponse({ description: 'Rate-limited.' })
  async listTemplates(
    @Tenant() t: TenantContext,
    @Query() q: ListSchedulesTemplatesQuery,
  ): Promise<ScheduleTemplateResponseDto[]> {
    const kgId = requireTenant(t);
    const items = await this.service.listTemplates(kgId, {
      groupId: q.groupId,
      isActive: q.isActive,
    });
    return items.map((x) => SchedulePresenter.template(x));
  }

  @Post('templates')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a schedule template.' })
  @ApiCreatedResponse({ type: ScheduleTemplateResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({ description: 'group_not_found.' })
  @ApiUnprocessableEntityResponse({
    description:
      'Domain invariant violation (e.g. valid_until before valid_from).',
  })
  @ApiTooManyRequestsResponse({ description: 'Rate-limited.' })
  async createTemplate(
    @Tenant() t: TenantContext,
    @Body() dto: CreateScheduleTemplateDto,
  ): Promise<ScheduleTemplateResponseDto> {
    const kgId = requireTenant(t);
    const created = await this.service.createTemplate(kgId, {
      groupId: dto.groupId ?? null,
      name: dto.name,
      recurrence: dto.recurrence,
      validFrom: new Date(dto.validFrom),
      validUntil: dto.validUntil ? new Date(dto.validUntil) : null,
      isActive: dto.isActive,
    });
    return SchedulePresenter.template(created);
  }

  @Get('templates/:id')
  @ApiOperation({ summary: 'Get template + slots.' })
  @ApiOkResponse({ type: ScheduleTemplateResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({ description: 'schedule_template_not_found.' })
  async getTemplate(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ScheduleTemplateResponseDto> {
    const kgId = requireTenant(t);
    const tpl = await this.service.getTemplate(kgId, id);
    return SchedulePresenter.template(tpl);
  }

  @Patch('templates/:id')
  @ApiOperation({ summary: 'Update template (name / isActive / validUntil).' })
  @ApiOkResponse({ type: ScheduleTemplateResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({ description: 'schedule_template_not_found.' })
  @ApiUnprocessableEntityResponse({
    description: 'Domain invariant violation.',
  })
  async updateTemplate(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateScheduleTemplateDto,
  ): Promise<ScheduleTemplateResponseDto> {
    const kgId = requireTenant(t);
    const tpl = await this.service.updateTemplate(kgId, id, {
      name: dto.name,
      isActive: dto.isActive,
      validUntil:
        dto.validUntil === undefined
          ? undefined
          : dto.validUntil === null
            ? null
            : new Date(dto.validUntil),
    });
    return SchedulePresenter.template(tpl);
  }

  @Delete('templates/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete template (cascades slots).' })
  @ApiNoContentResponse({ description: 'Deleted.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({ description: 'schedule_template_not_found.' })
  async deleteTemplate(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    const kgId = requireTenant(t);
    await this.service.deleteTemplate(kgId, id);
  }

  // ── Slots ────────────────────────────────────────────────────────────────

  @Post('templates/:id/slots')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add a slot to a template.' })
  @ApiCreatedResponse({ type: ScheduleTemplateResponseDto })
  @ApiBadRequestResponse({
    description: 'Validation error / invalid_slot_time.',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({ description: 'schedule_template_not_found.' })
  @ApiConflictResponse({ description: 'slot_time_conflict.' })
  @ApiUnprocessableEntityResponse({
    description: 'Domain invariant violation.',
  })
  async addSlot(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) templateId: string,
    @Body() dto: CreateSlotDto,
  ): Promise<ScheduleTemplateResponseDto> {
    const kgId = requireTenant(t);
    const tpl = await this.service.addSlot(kgId, templateId, {
      dayOfWeek: dto.dayOfWeek,
      startTime: dto.startTime,
      endTime: dto.endTime,
      activityName: dto.activityName,
      category: dto.category ?? null,
      locationId: dto.locationId ?? null,
      description: dto.description ?? null,
    });
    return SchedulePresenter.template(tpl);
  }

  @Patch('templates/:id/slots/:slotId')
  @ApiOperation({ summary: 'Update a slot.' })
  @ApiOkResponse({ type: ScheduleTemplateResponseDto })
  @ApiBadRequestResponse({
    description: 'Validation error / invalid_slot_time.',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({
    description: 'schedule_template_not_found / slot_not_found.',
  })
  @ApiConflictResponse({ description: 'slot_time_conflict.' })
  @ApiUnprocessableEntityResponse({
    description: 'Domain invariant violation.',
  })
  async updateSlot(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) templateId: string,
    @Param('slotId', new ParseUUIDPipe()) slotId: string,
    @Body() dto: UpdateSlotDto,
  ): Promise<ScheduleTemplateResponseDto> {
    const kgId = requireTenant(t);
    const tpl = await this.service.updateSlot(kgId, templateId, slotId, {
      dayOfWeek: dto.dayOfWeek,
      startTime: dto.startTime,
      endTime: dto.endTime,
      activityName: dto.activityName,
      category: dto.category,
      locationId: dto.locationId ?? null,
      description: dto.description ?? null,
    });
    return SchedulePresenter.template(tpl);
  }

  @Delete('templates/:id/slots/:slotId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a slot.' })
  @ApiNoContentResponse({ description: 'Deleted.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({
    description: 'schedule_template_not_found / slot_not_found.',
  })
  async removeSlot(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) templateId: string,
    @Param('slotId', new ParseUUIDPipe()) slotId: string,
  ): Promise<void> {
    const kgId = requireTenant(t);
    await this.service.removeSlot(kgId, templateId, slotId);
  }

  // ── Activity events ─────────────────────────────────────────────────────

  @Get('activity-events')
  @ApiOperation({ summary: 'List activity_events with optional filters.' })
  @ApiOkResponse({ type: [ActivityEventResponseDto] })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  async listEvents(
    @Tenant() t: TenantContext,
    @Query() q: ListActivityEventsQuery,
  ): Promise<ActivityEventResponseDto[]> {
    const kgId = requireTenant(t);
    const events = await this.service.listEvents(kgId, {
      groupId: q.groupId,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
      status: q.status,
    });
    const names = await this.service.resolveLocationNames(kgId, events);
    return SchedulePresenter.events(events, names);
  }

  @Post('activity-events')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create ad-hoc activity_event.' })
  @ApiCreatedResponse({ type: ActivityEventResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({ description: 'group_not_found.' })
  @ApiUnprocessableEntityResponse({
    description: 'Domain invariant violation.',
  })
  async createEvent(
    @Tenant() t: TenantContext,
    @Body() dto: CreateActivityEventDto,
  ): Promise<ActivityEventResponseDto> {
    const kgId = requireTenant(t);
    const created = await this.service.createAdHocEvent(kgId, {
      groupId: dto.groupId,
      activityName: dto.activityName,
      category: dto.category ?? null,
      locationId: dto.locationId ?? null,
      startsAt: new Date(dto.startsAt),
      endsAt: dto.endsAt ? new Date(dto.endsAt) : null,
      notes: dto.notes ?? null,
    });
    const name = await this.service.resolveLocationName(kgId, created);
    return SchedulePresenter.event(created, name);
  }

  @Patch('activity-events/:id')
  @ApiOperation({
    summary: 'Update activity_event (only when status=scheduled).',
  })
  @ApiOkResponse({ type: ActivityEventResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({ description: 'activity_event_not_found.' })
  @ApiConflictResponse({ description: 'invalid_activity_event_transition.' })
  async updateEvent(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateActivityEventDto,
  ): Promise<ActivityEventResponseDto> {
    const kgId = requireTenant(t);
    const updated = await this.service.updateEvent(kgId, id, {
      activityName: dto.activityName,
      category: dto.category,
      locationId: dto.locationId ?? null,
      startsAt: dto.startsAt ? new Date(dto.startsAt) : undefined,
      endsAt: dto.endsAt ? new Date(dto.endsAt) : undefined,
      notes: dto.notes ?? null,
    });
    const name = await this.service.resolveLocationName(kgId, updated);
    return SchedulePresenter.event(updated, name);
  }

  @Delete('activity-events/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete activity_event (only when status=scheduled).',
  })
  @ApiNoContentResponse({ description: 'Deleted.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({ description: 'activity_event_not_found.' })
  @ApiConflictResponse({
    description:
      'activity_event_not_deletable — already started/completed/cancelled.',
  })
  async deleteEvent(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    const kgId = requireTenant(t);
    await this.service.deleteEvent(kgId, id);
  }

  // ── Week snapshots ──────────────────────────────────────────────────────

  @Get('week-snapshots')
  @ApiOperation({ summary: 'List week-copy snapshot records.' })
  @ApiOkResponse({ type: [ScheduleWeekSnapshotResponseDto] })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  async listSnapshots(
    @Tenant() t: TenantContext,
    @Query() q: ListWeekSnapshotsQuery,
  ): Promise<ScheduleWeekSnapshotResponseDto[]> {
    const kgId = requireTenant(t);
    const items = await this.service.listWeekSnapshots(kgId, {
      groupId: q.groupId,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
    });
    return items.map((s) => SchedulePresenter.weekSnapshot(s));
  }

  @Post('week-snapshots/copy')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Manual trigger of the cron `schedule:auto-copy` — projects active templates onto next week. Idempotent per group.',
  })
  @ApiOkResponse({ type: WeekCopySummaryDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  async copyWeek(
    @Tenant() t: TenantContext,
    @Body() dto: CopyWeekDto,
  ): Promise<WeekCopySummaryDto> {
    const kgId = requireTenant(t);
    const result = await this.service.copyWeekToNext(
      kgId,
      new Date(dto.fromMonday),
      'manual',
    );
    return {
      copiedGroups: result.copiedGroups,
      skippedGroups: result.skippedGroups,
      totalEvents: result.totalEvents,
    };
  }

  @Post('week-snapshots/rebuild')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Force re-projection of active templates onto every already-materialized week from the current ISO week forward.',
    description:
      'Template edits normally re-sync themselves — every template/slot mutation calls this same routine. This endpoint is the manual escape hatch for one-off data repair (e.g. weeks materialized before the auto-resync existed, which parents still see as stale ghost slots).\n\nOnly rewrites events with `origin=template`, `status=scheduled` and `starts_at > now`: ad-hoc events, events already started/completed/cancelled, and anything earlier today are all preserved. Weeks without a snapshot are NOT materialized here — the weekly cron owns that horizon. Safe to re-run; running it twice in a row is a no-op the second time.',
  })
  @ApiOkResponse({ type: RematerializeSummaryDto })
  @ApiBadRequestResponse({
    description: 'Validation error (groupId is not a UUID) / tenant_required.',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  async rebuildWeekSnapshots(
    @Tenant() t: TenantContext,
    @Body() dto: RebuildWeekSnapshotsDto,
  ): Promise<RematerializeSummaryDto> {
    const kgId = requireTenant(t);
    const result = await this.service.rematerializeFutureWeeks(kgId, {
      groupId: dto.groupId ?? null,
    });
    return {
      rebuiltWeeks: result.rebuiltWeeks,
      deletedEvents: result.deletedEvents,
      insertedEvents: result.insertedEvents,
    };
  }
}
