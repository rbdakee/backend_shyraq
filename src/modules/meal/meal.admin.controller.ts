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
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { Roles } from '@/common/decorators/roles.decorator';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { PendingRoleSelectGuard } from '@/common/guards/pending-role-select.guard';
import { RolesGuard } from '@/common/guards/roles.guard';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';
import { CopyWeekDto } from './dto/copy-week.dto';
import { CreateMealItemDto } from './dto/create-meal-item.dto';
import { CreateMealPlanDto } from './dto/create-meal-plan.dto';
import { ListMealPlansQuery } from './dto/list-meal-plans.query';
import {
  CopyWeekSummaryDto,
  MealPlanResponseDto,
} from './dto/meal-plan.response.dto';
import { UpdateMealItemDto } from './dto/update-meal-item.dto';
import { UpdateMealPlanDto } from './dto/update-meal-plan.dto';
import { MealService } from './meal.service';

function requireTenant(t: TenantContext): string {
  if (!t.kgId) throw new BadRequestException('tenant_required');
  return t.kgId;
}

@ApiTags('Admin / Meal Plans')
@ApiBearerAuth()
@Controller({ path: 'admin/meal-plans', version: '1' })
@UseGuards(JwtAuthGuard, PendingRoleSelectGuard, RolesGuard)
@Roles('admin')
export class MealAdminController {
  constructor(private readonly service: MealService) {}

  // ── POST /admin/meal-plans/copy-week — MUST be before /:id ──────────────

  @Post('copy-week')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Manually copy previous week menu to next week.' })
  @ApiOkResponse({ type: CopyWeekSummaryDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Admin role required.' })
  @ApiUnprocessableEntityResponse({ description: 'Invalid date.' })
  async copyWeek(
    @Tenant() t: TenantContext,
    @Body() dto: CopyWeekDto,
  ): Promise<CopyWeekSummaryDto> {
    const kgId = requireTenant(t);
    const fromMonday = new Date(dto.source_week_start_date);
    return this.service.copyWeekMenuToNext(kgId, fromMonday, 'manual');
  }

  // ── Plans CRUD ────────────────────────────────────────────────────────────

  @Get()
  @ApiOperation({ summary: 'List meal plans by date range.' })
  @ApiOkResponse({ type: [MealPlanResponseDto] })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Admin role required.' })
  async list(
    @Tenant() t: TenantContext,
    @Query() query: ListMealPlansQuery,
  ): Promise<MealPlanResponseDto[]> {
    const kgId = requireTenant(t);
    const plans = await this.service.listPlans(kgId, {
      dateFrom: query.date_from,
      dateTo: query.date_to,
      groupId: query.group_id,
    });
    return plans.map(MealPlanResponseDto.fromDomain);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a meal plan (with optional inline items).' })
  @ApiCreatedResponse({ type: MealPlanResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Admin role required.' })
  @ApiConflictResponse({ description: 'meal_plan_already_exists' })
  @ApiNotFoundResponse({ description: 'group_not_found' })
  @ApiUnprocessableEntityResponse({ description: 'Unprocessable entity.' })
  async create(
    @Tenant() t: TenantContext,
    @Body() dto: CreateMealPlanDto,
  ): Promise<MealPlanResponseDto> {
    const kgId = requireTenant(t);
    const plan = await this.service.createPlan(kgId, {
      date: dto.date,
      groupId: dto.group_id,
      isPublished: dto.is_published,
      notes: dto.notes,
      items: dto.items?.map((i) => ({
        mealType: i.meal_type,
        dishName: i.dish_name,
        description: i.description,
        allergens: i.allergens,
        photoUrl: i.photo_url,
        calories: i.calories,
        serveTime: i.serve_time,
        position: i.position,
      })),
    });
    return MealPlanResponseDto.fromDomain(plan);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a meal plan with all items.' })
  @ApiOkResponse({ type: MealPlanResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Admin role required.' })
  @ApiNotFoundResponse({ description: 'meal_plan_not_found' })
  async getOne(
    @Tenant() t: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MealPlanResponseDto> {
    const kgId = requireTenant(t);
    const plan = await this.service.getPlan(kgId, id);
    return MealPlanResponseDto.fromDomain(plan);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a meal plan (is_published, notes).' })
  @ApiOkResponse({ type: MealPlanResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Admin role required.' })
  @ApiNotFoundResponse({ description: 'meal_plan_not_found' })
  async update(
    @Tenant() t: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateMealPlanDto,
  ): Promise<MealPlanResponseDto> {
    const kgId = requireTenant(t);
    const plan = await this.service.updatePlan(kgId, id, {
      isPublished: dto.is_published,
      notes: dto.notes,
    });
    return MealPlanResponseDto.fromDomain(plan);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a meal plan (cascades items).' })
  @ApiNoContentResponse({ description: 'Plan deleted.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Admin role required.' })
  @ApiNotFoundResponse({ description: 'meal_plan_not_found' })
  async remove(
    @Tenant() t: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    const kgId = requireTenant(t);
    await this.service.deletePlan(kgId, id);
  }

  // ── Items ─────────────────────────────────────────────────────────────────

  @Post(':id/items')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add a dish to a meal plan.' })
  @ApiCreatedResponse({ type: MealPlanResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Admin role required.' })
  @ApiNotFoundResponse({ description: 'meal_plan_not_found' })
  @ApiUnprocessableEntityResponse({ description: 'invalid_meal_type' })
  async addItem(
    @Tenant() t: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateMealItemDto,
  ): Promise<MealPlanResponseDto> {
    const kgId = requireTenant(t);
    const plan = await this.service.addItem(kgId, id, {
      mealType: dto.meal_type,
      dishName: dto.dish_name,
      description: dto.description,
      allergens: dto.allergens,
      photoUrl: dto.photo_url,
      calories: dto.calories,
      serveTime: dto.serve_time,
      position: dto.position,
    });
    return MealPlanResponseDto.fromDomain(plan);
  }

  @Patch(':id/items/:itemId')
  @ApiOperation({ summary: 'Update a dish in a meal plan.' })
  @ApiOkResponse({ type: MealPlanResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Admin role required.' })
  @ApiNotFoundResponse({
    description: 'meal_plan_not_found or meal_item_not_found',
  })
  async updateItem(
    @Tenant() t: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: UpdateMealItemDto,
  ): Promise<MealPlanResponseDto> {
    const kgId = requireTenant(t);
    const plan = await this.service.updateItem(kgId, id, itemId, {
      mealType: dto.meal_type,
      dishName: dto.dish_name,
      description: dto.description,
      allergens: dto.allergens,
      photoUrl: dto.photo_url,
      calories: dto.calories,
      serveTime: dto.serve_time,
      position: dto.position,
    });
    return MealPlanResponseDto.fromDomain(plan);
  }

  @Delete(':id/items/:itemId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a dish from a meal plan.' })
  @ApiNoContentResponse({ description: 'Item deleted.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Admin role required.' })
  @ApiNotFoundResponse({
    description: 'meal_plan_not_found or meal_item_not_found',
  })
  async removeItem(
    @Tenant() t: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ): Promise<void> {
    const kgId = requireTenant(t);
    await this.service.removeItem(kgId, id, itemId);
  }
}
