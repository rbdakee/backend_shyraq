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
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import {
  formatDateInTimezone,
  isoWeekdayOf,
} from '@/shared-kernel/domain/value-objects/day-of-week.vo';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';
import { ParentMenuQuery } from './dto/list-meal-plans.query';
import { MealMenuWeekResponseDto } from './dto/meal-plan.response.dto';
import { MealService } from './meal.service';

function requireTenant(t: TenantContext): string {
  if (!t.kgId) throw new BadRequestException('tenant_required');
  return t.kgId;
}

/**
 * Parent-scoped meal menu endpoint. Uses `ChildAccessGuard` so only approved
 * guardians of the child can access its group's weekly menu.
 * Visibility: only `is_published=true` plans are returned.
 */
@ApiTags('Parent / Children Menu')
@ApiBearerAuth()
@Controller({ path: 'parent/children', version: '1' })
@UseGuards(JwtAuthGuard, PendingRoleSelectGuard, ChildAccessGuard)
export class MealParentController {
  constructor(
    private readonly service: MealService,
    @Inject(ClockPort) private readonly clock: ClockPort,
  ) {}

  @Get(':childId/menu')
  @ApiOperation({
    summary: "Get a child's weekly meal menu (published plans only).",
  })
  @ApiOkResponse({ type: MealMenuWeekResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({
    description: 'Not an approved guardian of this child.',
  })
  @ApiNotFoundResponse({ description: 'Child not found.' })
  async getWeekMenu(
    @Tenant() t: TenantContext,
    @Param('childId', ParseUUIDPipe) childId: string,
    @Query() query: ParentMenuQuery,
  ): Promise<MealMenuWeekResponseDto> {
    const kgId = requireTenant(t);

    // Default week_start = Monday of current week
    const weekStart = query.week_start ?? getThisMonday(this.clock.now());

    return this.service.getMenuForChild(kgId, childId, weekStart);
  }
}

/**
 * SP3: Monday-of-the-current-week in `Asia/Almaty`. The previous
 * implementation derived `day` from `Date.getDay()` (UTC wall-clock) which
 * jumps to the previous week on Sunday-evening Almaty (UTC still says
 * Sunday, but Almaty is already Monday, so iso=1 should anchor on TODAY,
 * not 7 days back).
 *
 * Strategy: ask the shared helper for the iso-weekday in Asia/Almaty
 * (1=Mon..7=Sun), subtract `iso-1` Almaty-days from today's Almaty
 * calendar date. We do the arithmetic by parsing the YYYY-MM-DD string
 * into a midnight-UTC Date — the offset is purely calendar arithmetic
 * (24h * N), no DST in Asia/Almaty so this is safe.
 */
function getThisMonday(now: Date): string {
  const iso = isoWeekdayOf(now); // 1..7 in Asia/Almaty
  const todayAlmatyIso = formatDateInTimezone(now);
  const todayAnchor = new Date(`${todayAlmatyIso}T00:00:00.000Z`);
  const monday = new Date(
    todayAnchor.getTime() - (iso - 1) * 24 * 60 * 60 * 1000,
  );
  return formatDateInTimezone(monday);
}
