import {
  BadRequestException,
  Controller,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { PendingRoleSelectGuard } from '@/common/guards/pending-role-select.guard';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';
import { ListMealPlansByDateQuery } from './dto/list-meal-plans.query';
import { MealPlanResponseDto } from './dto/meal-plan.response.dto';
import { MealService } from './meal.service';

function requireTenant(t: TenantContext): string {
  if (!t.kgId) throw new BadRequestException('tenant_required');
  return t.kgId;
}

/**
 * Staff-scoped read endpoints for meal plans (B7).
 * Staff can view today's or a specified date's menu filtered by group.
 */
@ApiTags('Staff / Meal Plans')
@ApiBearerAuth()
@Controller({ path: 'staff/meal-plans', version: '1' })
@UseGuards(JwtAuthGuard, PendingRoleSelectGuard)
export class MealStaffController {
  constructor(private readonly service: MealService) {}

  @Get()
  @ApiOperation({ summary: 'Get meal plans for staff (by date and/or group).' })
  @ApiOkResponse({ type: [MealPlanResponseDto] })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Staff role required.' })
  async list(
    @Tenant() t: TenantContext,
    @Query() query: ListMealPlansByDateQuery,
  ): Promise<MealPlanResponseDto[]> {
    const kgId = requireTenant(t);
    const date = query.date ?? new Date().toISOString().slice(0, 10);
    const plans = await this.service.listPlans(kgId, {
      dateFrom: date,
      dateTo: date,
      groupId: query.group_id,
    });
    return plans.map(MealPlanResponseDto.fromDomain);
  }
}
