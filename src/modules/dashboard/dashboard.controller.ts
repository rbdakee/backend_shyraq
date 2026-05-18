import {
  BadRequestException,
  Controller,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Roles } from '@/common/decorators/roles.decorator';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { PendingRoleSelectGuard } from '@/common/guards/pending-role-select.guard';
import { RolesGuard } from '@/common/guards/roles.guard';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';
import { DashboardService } from './dashboard.service';
import { DashboardSummaryResponseDto } from './dto/dashboard-summary.response';
import { PaymentsOverviewQuery } from './dto/payments-overview.query';
import { PaymentsOverviewResponseDto } from './dto/payments-overview.response';
import { AttendanceTodayQuery } from './dto/attendance-today.query';
import { AttendanceTodayResponseDto } from './dto/attendance-today.response';

const TENANT_REQUIRED = 'tenant_required';

function requireTenant(t: TenantContext): string {
  if (!t.kgId) throw new BadRequestException(TENANT_REQUIRED);
  return t.kgId;
}

/**
 * Admin dashboard read-only analytics (B-DASH). Same guard/role surface as
 * AdminAttendanceController: JWT + pending-role-select + roles, scoped to
 * admin/reception, tenant derived from @Tenant().
 */
@ApiTags('Admin / Dashboard')
@ApiBearerAuth()
@Controller({ path: 'admin', version: '1' })
@UseGuards(JwtAuthGuard, PendingRoleSelectGuard, RolesGuard)
@Roles('admin', 'reception')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get('dashboard/summary')
  @ApiOperation({
    summary:
      'Dashboard KPI aggregate: active children/staff/groups, in-processing enrollments, overdue invoices, MTD/YTD revenue.',
  })
  @ApiOkResponse({ type: DashboardSummaryResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin/reception.' })
  async summary(
    @Tenant() t: TenantContext,
  ): Promise<DashboardSummaryResponseDto> {
    const kgId = requireTenant(t);
    return this.dashboardService.getSummary(kgId);
  }

  @Get('dashboard/payments-overview')
  @ApiOperation({
    summary:
      'Payments overview for a date range: paid/pending/overdue/refunded invoice buckets + completed-payment breakdown by provider.',
  })
  @ApiOkResponse({ type: PaymentsOverviewResponseDto })
  @ApiBadRequestResponse({
    description: 'Validation error or invalid_date_range (to < from).',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin/reception.' })
  async paymentsOverview(
    @Tenant() t: TenantContext,
    @Query() q: PaymentsOverviewQuery,
  ): Promise<PaymentsOverviewResponseDto> {
    const kgId = requireTenant(t);
    return this.dashboardService.getPaymentsOverview(kgId, {
      from: q.from,
      to: q.to,
    });
  }

  @Get('dashboard/attendance-today')
  @ApiOperation({
    summary:
      "Today's attendance donut aggregate (Asia/Almaty): in_kindergarten / checked_out / absent / on_vacation / sick.",
  })
  @ApiOkResponse({ type: AttendanceTodayResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin/reception.' })
  @ApiQuery({
    name: 'group_id',
    required: false,
    description: 'Filter by group (children.current_group_id).',
  })
  @ApiQuery({
    name: 'date',
    required: false,
    description: 'Date override YYYY-MM-DD (defaults to today in Asia/Almaty).',
  })
  async attendanceToday(
    @Tenant() t: TenantContext,
    @Query() q: AttendanceTodayQuery,
  ): Promise<AttendanceTodayResponseDto> {
    const kgId = requireTenant(t);
    return this.dashboardService.getAttendanceToday(kgId, {
      groupId: q.group_id,
      date: q.date,
    });
  }
}
