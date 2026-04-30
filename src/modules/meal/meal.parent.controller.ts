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
  constructor(private readonly service: MealService) {}

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
    const weekStart = query.week_start ?? getThisMonday();

    return this.service.getMenuForChild(kgId, childId, weekStart);
  }
}

function getThisMonday(): string {
  const now = new Date();
  const day = now.getDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setDate(monday.getDate() + diff);
  return monday.toISOString().slice(0, 10);
}
