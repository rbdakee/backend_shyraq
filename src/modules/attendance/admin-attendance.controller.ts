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
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
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
import { AuditService } from '@/modules/audit/audit.service';
import { AttendancePresenter } from './attendance.presenter';
import { AttendanceService } from './attendance.service';
import { AttendanceEvent } from './domain/entities/attendance-event.entity';
import { AdminPatchAttendanceDto } from './dto/admin-patch-attendance.dto';
import { AttendanceEventResponseDto } from './dto/attendance-event.response';
import { AuditLogEntryResponseDto } from './dto/audit-log-entry.response';
import { CheckInDto } from './dto/check-in.dto';
import { CheckOutDto } from './dto/check-out.dto';
import { DailyStatusResponseDto } from './dto/daily-status.response';
import { ListAttendanceEventsQuery } from './dto/list-attendance-events.query';
import { ListAuditLogQuery } from './dto/list-audit-log.query';
import { ListDailyStatusQuery } from './dto/list-daily-status.query';
import { ListTimelineQuery } from './dto/list-timeline.query';
import { PagedTimelineResponseDto } from './dto/timeline-entry.response';
import { SetDailyStatusDto } from './dto/set-daily-status.dto';
import { TimelinePresenter } from './timeline.presenter';
import { TimelineService } from './timeline.service';

const TENANT_REQUIRED = 'tenant_required';

function requireTenant(t: TenantContext): string {
  if (!t.kgId) throw new BadRequestException(TENANT_REQUIRED);
  return t.kgId;
}

/**
 * Admin-scoped attendance endpoints — oversight (B8 T4) plus the admin web
 * panel's own register-keeping.
 *
 * The admin panel runs the same two-step door flow as the staff app:
 * `POST /admin/qr/scan` resolves the parent's QR into linked children, then
 * one of the check-in / check-out routes here writes the event. The scan
 * itself never writes attendance.
 *
 * Why these duplicate `/staff/attendance/*` rather than widening its
 * `@Roles`: the paths are the admin panel's contract, but every handler
 * delegates to the SAME `AttendanceService` methods — there is no second
 * implementation of check-in. The two surfaces differ only in what they are
 * allowed to do:
 *   - no edit-window on PATCH (staff is capped at the same calendar day in
 *     Asia/Almaty; an admin can fix any historical event);
 *   - child_id / event_type corrections and DELETE are admin-only;
 *   - back-dated writes are silent (see `notifyFor`).
 *
 * Everything mutating here is journalled to `audit_log` and readable back via
 * `GET attendance-events/:eventId/history`.
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
    private readonly auditService: AuditService,
  ) {}

  // ── Record attendance ────────────────────────────────────────────────────

  @Post('attendance/check-in')
  @ApiOperation({
    summary:
      'Record a check-in. Use after POST /admin/qr/scan (QR flow), or with a childId picked by hand (manual entry / back-fill).',
    description:
      'Omit `recordedAt` for a live arrival. Pass a past `recordedAt` to back-fill a day that was not recorded at the time — ' +
      'the row, its timeline entry and its audit entry are still written, but the parent push is suppressed (see the notification note on check-out).',
  })
  @ApiCreatedResponse({ type: AttendanceEventResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error / tenant_required.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin/reception.' })
  @ApiNotFoundResponse({
    description: 'child_not_found or staff_member_not_found.',
  })
  async checkIn(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CheckInDto,
  ): Promise<AttendanceEventResponseDto> {
    const kgId = requireTenant(t);
    const recordedAt = dto.recordedAt ? new Date(dto.recordedAt) : undefined;
    const result = await this.attendanceService.checkIn(
      kgId,
      dto.childId,
      user.sub,
      {
        recordedAt,
        notes: dto.notes,
        notify: this.notifyFor(recordedAt),
      },
    );
    return (await this.presentEvents(kgId, [result.event]))[0];
  }

  @Post('attendance/check-out')
  @ApiOperation({
    summary:
      'Record a check-out. `pickupUserId` must be an approved active pickup guardian for the child.',
    description:
      'Same back-fill semantics as check-in. Note check-out deliberately does NOT change the child’s daily status — ' +
      'the intra-day status only moves on check-in or via POST /admin/daily-status.',
  })
  @ApiCreatedResponse({ type: AttendanceEventResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error / tenant_required.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({
    description:
      'Caller is not admin/reception, or `pickup_user_not_allowed` — the user is not an approved active pickup guardian for this child.',
  })
  @ApiNotFoundResponse({
    description: 'child_not_found or staff_member_not_found.',
  })
  async checkOut(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CheckOutDto,
  ): Promise<AttendanceEventResponseDto> {
    const kgId = requireTenant(t);
    const recordedAt = dto.recordedAt ? new Date(dto.recordedAt) : undefined;
    const result = await this.attendanceService.checkOut(
      kgId,
      dto.childId,
      user.sub,
      dto.pickupUserId,
      {
        recordedAt,
        notes: dto.notes,
        notify: this.notifyFor(recordedAt),
      },
    );
    return (await this.presentEvents(kgId, [result.event]))[0];
  }

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
    return this.presentEvents(kgId, events);
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
    return (await this.presentEvents(kgId, [event]))[0];
  }

  @Patch('attendance-events/:eventId')
  @ApiOperation({
    summary:
      'Admin-level patch of an attendance event. No edit-window restriction (admin can fix any historical event).',
    description:
      'Beyond the staff-patchable fields, an admin may correct `childId` (record filed against the wrong kid) and ' +
      '`eventType` (mis-pressed button). Both cascade to the paired timeline entry and recompute daily_status for every ' +
      'affected child+day. `method` stays immutable — it records how the row came to exist. Silent: no parent notification.',
  })
  @ApiOkResponse({ type: AttendanceEventResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({
    description:
      'Caller is not admin/reception, or `pickup_user_not_allowed` for the resulting (child, pickup user) pair.',
  })
  @ApiNotFoundResponse({
    description: 'attendance_event_not_found or child_not_found.',
  })
  async patchEvent(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Param('eventId', new ParseUUIDPipe()) eventId: string,
    @Body() dto: AdminPatchAttendanceDto,
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
        childId: dto.childId,
        eventType: dto.eventType,
      },
      {
        // Reception reaches this route too (class-level @Roles). It keeps the
        // window bypass — correcting an earlier day is what the route is for —
        // but `childId`/`eventType` stay admin-only, so the grant is derived
        // from the caller's actual role rather than from the route.
        skipEditWindow: true,
        allowStructuralCorrection: user.role === 'admin',
      },
    );
    return (await this.presentEvents(kgId, [updated]))[0];
  }

  @Delete('attendance-events/:eventId')
  // Narrower than the class: deleting an event is admin-only. RolesGuard uses
  // reflector.getAllAndOverride([handler, class]), so this REPLACES the
  // class-level list rather than merging with it.
  @Roles('admin')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Soft-delete an attendance event recorded by mistake.',
    description:
      'The row is tombstoned, not dropped, so its history stays resolvable — but it disappears from every read: ' +
      'the events list, the child timeline, and the dashboard counters. The paired timeline entry is removed and ' +
      'daily_status is recomputed (a child left with no check-in that day falls back from `present` to `absent`, ' +
      'while an explicit `sick` / `on_vacation` is preserved). Re-deleting returns 404. Silent: no parent notification.',
  })
  @ApiNoContentResponse({ description: 'Deleted.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin/reception.' })
  @ApiNotFoundResponse({
    description: 'attendance_event_not_found (unknown, or already deleted).',
  })
  async deleteEvent(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Param('eventId', new ParseUUIDPipe()) eventId: string,
  ): Promise<void> {
    const kgId = requireTenant(t);
    await this.attendanceService.deleteEvent(kgId, eventId, user.sub);
  }

  @Get('attendance-events/:eventId/history')
  @ApiOperation({
    summary:
      'Correction history for one attendance event — who changed what, and when.',
    description:
      'Newest first. Reads `audit_log`, so it survives the event being soft-deleted: pass the id of a deleted event ' +
      'to see the `delete` entry and its `before` snapshot. An event never touched since creation returns exactly one `create` entry.',
  })
  @ApiOkResponse({ type: [AuditLogEntryResponseDto] })
  @ApiBadRequestResponse({ description: 'Validation error / tenant_required.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin/reception.' })
  async getEventHistory(
    @Tenant() t: TenantContext,
    @Param('eventId', new ParseUUIDPipe()) eventId: string,
    @Query() q: ListAuditLogQuery,
  ): Promise<AuditLogEntryResponseDto[]> {
    const kgId = requireTenant(t);
    // No existence check on the event: history outlives the row, so a
    // soft-deleted (or purged) event must still return its trail. An unknown
    // id simply has no entries.
    const entries = await this.auditService.listByEntity(
      kgId,
      'attendance_event',
      eventId,
      { limit: q.limit, offset: q.offset },
    );
    const actorNames = await this.attendanceService.resolveActorNames(
      kgId,
      entries,
    );
    return entries.map((e) =>
      AttendancePresenter.auditEntry(
        e,
        e.actorStaffId ? (actorNames.get(e.actorStaffId) ?? null) : null,
      ),
    );
  }

  // ── Daily status ─────────────────────────────────────────────────────────

  @Post('daily-status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Set a child’s status for a date (absent / sick / on_vacation / late / early_pickup / present). Upsert on (childId, date).',
    description:
      'An explicit status outranks anything inferred from the event log: a `sick` set here is not overwritten by a later ' +
      'check-in, nor demoted when events are corrected. Returns 200 (upsert), not 201.',
  })
  @ApiOkResponse({ type: DailyStatusResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error / tenant_required.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin/reception.' })
  @ApiNotFoundResponse({
    description: 'child_not_found or staff_member_not_found.',
  })
  async setDailyStatus(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Body() dto: SetDailyStatusDto,
  ): Promise<DailyStatusResponseDto> {
    const kgId = requireTenant(t);
    const status = await this.attendanceService.setDailyStatus(kgId, user.sub, {
      childId: dto.childId,
      date: dto.date,
      status: dto.status,
      note: dto.note,
    });
    const setByNames = await this.attendanceService.resolveSetByNames(kgId, [
      status,
    ]);
    return AttendancePresenter.dailyStatus(
      status,
      status.setBy ? (setByNames.get(status.setBy) ?? null) : null,
    );
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
    const setByNames = await this.attendanceService.resolveSetByNames(
      kgId,
      statuses,
    );
    return statuses.map((s) =>
      AttendancePresenter.dailyStatus(
        s,
        s.setBy ? (setByNames.get(s.setBy) ?? null) : null,
      ),
    );
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
    const recordedByNames = await this.timelineService.resolveRecordedByNames(
      kgId,
      result.items,
    );
    return TimelinePresenter.paged(
      result.items,
      result.nextCursor,
      recordedByNames,
    );
  }

  /**
   * Whether the parent should be pushed for a write stamped `recordedAt`.
   *
   * Live arrivals notify as usual. A back-fill does not: an admin closing
   * yesterday's register at 22:00 must not tell parents their children just
   * arrived. Only the notification is suppressed — the event, its timeline
   * entry and its audit row are written either way.
   */
  private notifyFor(recordedAt: Date | undefined): boolean {
    return !this.attendanceService.isBackdated(recordedAt);
  }

  /**
   * Resolve identity overlays for a batch of attendance events and present
   * them. `recorded_by_full_name` (staff_members.id) and
   * `pickup_user_full_name` (users.id) are each resolved once per distinct id
   * — no N+1.
   */
  private async presentEvents(
    kgId: string,
    events: AttendanceEvent[],
  ): Promise<AttendanceEventResponseDto[]> {
    const [recordedByNames, pickupNames, childNames] = await Promise.all([
      this.attendanceService.resolveRecordedByNames(kgId, events),
      this.attendanceService.resolvePickupUserNames(events),
      this.attendanceService.resolveChildNames(kgId, events),
    ]);
    return events.map((e) =>
      AttendancePresenter.event(
        e,
        e.recordedBy ? (recordedByNames.get(e.recordedBy) ?? null) : null,
        e.pickupUserId ? (pickupNames.get(e.pickupUserId) ?? null) : null,
        childNames.get(e.childId) ?? null,
      ),
    );
  }
}
