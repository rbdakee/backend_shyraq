import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
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
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { PendingRoleSelectGuard } from '@/common/guards/pending-role-select.guard';
import { RolesGuard } from '@/common/guards/roles.guard';
import type { JwtPayload } from '@/common/types/jwt-payload';
import { GroupRepository } from '@/modules/group/infrastructure/persistence/group.repository';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';
import { AttendanceService } from './attendance.service';
import { AttendancePresenter } from './attendance.presenter';
import { AttendanceEvent } from './domain/entities/attendance-event.entity';
import { AttendanceEventResponseDto } from './dto/attendance-event.response';
import { CheckInDto } from './dto/check-in.dto';
import { CheckOutDto } from './dto/check-out.dto';
import { PatchAttendanceDto } from './dto/patch-attendance.dto';
import { StaffAttendanceTodayQuery } from './dto/staff-attendance-today.query';
import { StaffAttendanceTodayResponseDto } from './dto/staff-attendance-today.response';

const TENANT_REQUIRED = 'tenant_required';

function requireTenant(t: TenantContext): string {
  if (!t.kgId) throw new BadRequestException(TENANT_REQUIRED);
  return t.kgId;
}

/**
 * Staff-scoped attendance endpoints (B8 T3).
 *
 * Roles: mentor, specialist, reception. Admin lands on the corresponding
 * admin endpoints in T4 — staff PATCH is gated by the same-day edit window
 * (`AttendanceEditWindowExpiredError` → 403). For T3 the same controller is
 * marked `isAdmin: false` for every PATCH; admin bypass-window arrives in
 * T4's `admin-attendance.controller.ts`.
 */
@ApiTags('Staff / Attendance')
@ApiBearerAuth()
@Controller({ path: 'staff/attendance', version: '1' })
@UseGuards(JwtAuthGuard, PendingRoleSelectGuard, RolesGuard)
@Roles('mentor', 'specialist', 'reception')
export class StaffAttendanceController {
  constructor(
    private readonly service: AttendanceService,
    private readonly groupRepo: GroupRepository,
  ) {}

  @Get('today')
  @ApiOperation({
    summary:
      'Aggregate attendance donut counts for one Asia/Almaty calendar day. ' +
      'Mentors MUST pass a groupId they are actively assigned to; ' +
      'specialist/reception may omit it for a whole-kindergarten summary.',
  })
  @ApiQuery({
    name: 'groupId',
    required: false,
    description:
      'Scope to one group. Required for mentor (active assignment enforced).',
    example: 'a1b2c3d4-0000-0000-0000-000000000001',
  })
  @ApiQuery({
    name: 'date',
    required: false,
    description: 'ISO date YYYY-MM-DD. Defaults to Asia/Almaty today.',
    example: '2026-06-24',
  })
  @ApiOkResponse({ type: StaffAttendanceTodayResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({
    description:
      'Caller role not allowed / mentor_group_required (mentor omitted groupId) ' +
      '/ mentor_not_assigned_to_group (mentor not actively assigned to groupId).',
  })
  @ApiTooManyRequestsResponse({ description: 'Rate-limited.' })
  async today(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Query() query: StaffAttendanceTodayQuery,
  ): Promise<StaffAttendanceTodayResponseDto> {
    const kgId = requireTenant(t);

    // Mentors are scoped to the groups they actively mentor: a groupId is
    // mandatory and must be one of their active assignments in this kg.
    // Specialist / reception are kg-wide — groupId is an optional narrowing.
    if (user.role === 'mentor') {
      if (!query.groupId) {
        throw new ForbiddenException({ code: 'mentor_group_required' });
      }
      const assignments =
        await this.groupRepo.findActiveMentorAssignmentsByUserIdCrossTenant(
          user.sub,
          kgId,
        );
      const assignedGroupIds = new Set(assignments.map((a) => a.groupId));
      if (!assignedGroupIds.has(query.groupId)) {
        throw new ForbiddenException({ code: 'mentor_not_assigned_to_group' });
      }
    }

    return this.service.getDaySummary(kgId, {
      groupId: query.groupId,
      date: query.date,
    });
  }

  @Post('check-in')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Record a check-in. Atomic — writes attendance_events + timeline_entries + (conditional) child_daily_status in one transaction.',
  })
  @ApiCreatedResponse({ type: AttendanceEventResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller role not allowed.' })
  @ApiNotFoundResponse({
    description: 'child_not_found / staff_member not found.',
  })
  @ApiUnprocessableEntityResponse({
    description: 'Domain invariant violation.',
  })
  @ApiTooManyRequestsResponse({ description: 'Rate-limited.' })
  async checkIn(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CheckInDto,
  ): Promise<AttendanceEventResponseDto> {
    const kgId = requireTenant(t);
    const result = await this.service.checkIn(kgId, dto.childId, user.sub, {
      recordedAt: dto.recordedAt ? new Date(dto.recordedAt) : undefined,
      notes: dto.notes ?? null,
    });
    return this.presentEvent(kgId, result.event);
  }

  @Post('check-out')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Record a check-out. Validates pickup_user against approved active pickup guardians (403 pickup_user_not_allowed otherwise). Daily status NOT mutated on check-out.',
  })
  @ApiCreatedResponse({ type: AttendanceEventResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({
    description:
      'Caller role not allowed / pickup_user_not_allowed (not approved active pickup guardian).',
  })
  @ApiNotFoundResponse({
    description: 'child_not_found / staff_member not found.',
  })
  @ApiUnprocessableEntityResponse({
    description: 'Domain invariant violation.',
  })
  @ApiTooManyRequestsResponse({ description: 'Rate-limited.' })
  async checkOut(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CheckOutDto,
  ): Promise<AttendanceEventResponseDto> {
    const kgId = requireTenant(t);
    const result = await this.service.checkOut(
      kgId,
      dto.childId,
      user.sub,
      dto.pickupUserId,
      {
        recordedAt: dto.recordedAt ? new Date(dto.recordedAt) : undefined,
        notes: dto.notes ?? null,
      },
    );
    return this.presentEvent(kgId, result.event);
  }

  @Patch(':eventId')
  @ApiOperation({
    summary:
      'Patch attendance_event (recorded_at / notes / pickup_user_id). Non-admin: only when recorded_at is on the same calendar day in Asia/Almaty.',
  })
  @ApiOkResponse({ type: AttendanceEventResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({
    description:
      'Caller role not allowed / attendance_edit_window_expired / pickup_user_not_allowed.',
  })
  @ApiNotFoundResponse({ description: 'attendance_event_not_found.' })
  @ApiUnprocessableEntityResponse({
    description:
      'Domain validation (e.g. invalid_attendance_pickup — pickup_user_id on check_in).',
  })
  async patch(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Param('eventId', new ParseUUIDPipe()) eventId: string,
    @Body() dto: PatchAttendanceDto,
  ): Promise<AttendanceEventResponseDto> {
    const kgId = requireTenant(t);
    const updated = await this.service.patchEvent(
      kgId,
      eventId,
      user.sub,
      {
        recordedAt: dto.recordedAt ? new Date(dto.recordedAt) : undefined,
        notes: dto.notes,
        pickupUserId: dto.pickupUserId,
      },
      { skipEditWindow: false, allowStructuralCorrection: false },
    );
    return this.presentEvent(kgId, updated);
  }

  /**
   * Resolve the identity overlays for a single attendance event and hand them
   * to the presenter. `recorded_by_full_name` (staff_members.id) +
   * `pickup_user_full_name` (users.id) are both batched through the service
   * resolvers; for a single row each map has at most one entry.
   */
  private async presentEvent(
    kgId: string,
    event: AttendanceEvent,
  ): Promise<AttendanceEventResponseDto> {
    const [recordedByNames, pickupNames, childNames] = await Promise.all([
      this.service.resolveRecordedByNames(kgId, [event]),
      this.service.resolvePickupUserNames([event]),
      this.service.resolveChildNames(kgId, [event]),
    ]);
    return AttendancePresenter.event(
      event,
      event.recordedBy ? (recordedByNames.get(event.recordedBy) ?? null) : null,
      event.pickupUserId ? (pickupNames.get(event.pickupUserId) ?? null) : null,
      childNames.get(event.childId) ?? null,
    );
  }
}
