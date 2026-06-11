import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
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
import { DailyStatusResponseDto } from './dto/daily-status.response';
import { SetDailyStatusDto } from './dto/set-daily-status.dto';

const TENANT_REQUIRED = 'tenant_required';

function requireTenant(t: TenantContext): string {
  if (!t.kgId) throw new BadRequestException(TENANT_REQUIRED);
  return t.kgId;
}

/**
 * Staff-scoped daily-status endpoint (B8 T4).
 *
 * Roles: mentor, specialist, reception. Staff can set the daily status for
 * any child in their kindergarten tenant (RLS + explicit kgId guard).
 */
@ApiTags('Staff / Daily Status')
@ApiBearerAuth()
@Controller({ path: 'staff/daily-status', version: '1' })
@UseGuards(JwtAuthGuard, PendingRoleSelectGuard, RolesGuard)
@Roles('mentor', 'specialist', 'reception')
export class StaffDailyStatusController {
  constructor(private readonly service: AttendanceService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Set (upsert) the daily status for a child on the given date. Overwrites any prior value for the same (child_id, date) tuple.',
  })
  @ApiOkResponse({ type: DailyStatusResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller role not allowed.' })
  @ApiNotFoundResponse({
    description: 'child_not_found / staff_member not found.',
  })
  @ApiTooManyRequestsResponse({ description: 'Rate-limited.' })
  async setDailyStatus(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Body() dto: SetDailyStatusDto,
  ): Promise<DailyStatusResponseDto> {
    const kgId = requireTenant(t);
    const result = await this.service.setDailyStatus(kgId, user.sub, {
      childId: dto.childId,
      date: dto.date,
      status: dto.status,
      note: dto.note ?? null,
    });
    const setByNames = await this.service.resolveSetByNames(kgId, [result]);
    return AttendancePresenter.dailyStatus(
      result,
      result.setBy ? (setByNames.get(result.setBy) ?? null) : null,
    );
  }
}
