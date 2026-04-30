import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MealPlan } from '../domain/entities/meal-plan.entity';
import { MealItem } from '../domain/entities/meal-item.entity';

export class MealItemResponseDto {
  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  id: string;

  @ApiProperty({
    example: 'breakfast',
    enum: ['breakfast', 'snack_am', 'lunch', 'snack_pm', 'dinner'],
  })
  meal_type: string;

  @ApiProperty({ example: { ru: 'Овсяная каша', kk: 'Сұлы жармасы' } })
  dish_name: object;

  @ApiPropertyOptional({ example: { ru: 'Приготовлена без соли' } })
  description: object | null;

  @ApiPropertyOptional({ example: ['gluten', 'dairy'] })
  allergens: string[] | null;

  @ApiPropertyOptional({ example: 'https://cdn.example.com/meal.jpg' })
  photo_url: string | null;

  @ApiPropertyOptional({ example: 350 })
  calories: number | null;

  @ApiProperty({ example: 0 })
  position: number;

  static fromDomain(item: MealItem): MealItemResponseDto {
    const dto = new MealItemResponseDto();
    dto.id = item.id;
    dto.meal_type = item.mealType;
    dto.dish_name = item.dishName;
    dto.description = item.description;
    dto.allergens = item.allergens;
    dto.photo_url = item.photoUrl;
    dto.calories = item.calories;
    dto.position = item.position;
    return dto;
  }
}

export class MealPlanResponseDto {
  @ApiProperty({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  id: string;

  @ApiProperty({ example: '2026-05-01' })
  date: string;

  @ApiPropertyOptional({ example: '3fa85f64-5717-4562-b3fc-2c963f66afa6' })
  group_id: string | null;

  @ApiProperty({ example: true })
  is_published: boolean;

  @ApiPropertyOptional({ example: { ru: 'Праздничное меню' } })
  notes: object | null;

  @ApiProperty({ example: 'manual', enum: ['manual', 'cron', 'copied'] })
  source: string;

  @ApiPropertyOptional({ example: null })
  copied_from: string | null;

  @ApiProperty({ type: [MealItemResponseDto] })
  items: MealItemResponseDto[];

  @ApiProperty({ example: '2026-05-01T08:00:00.000Z' })
  created_at: string;

  @ApiProperty({ example: '2026-05-01T08:00:00.000Z' })
  updated_at: string;

  static fromDomain(plan: MealPlan): MealPlanResponseDto {
    const dto = new MealPlanResponseDto();
    dto.id = plan.id;
    dto.date = plan.date;
    dto.group_id = plan.groupId;
    dto.is_published = plan.isPublished;
    dto.notes = plan.notes;
    dto.source = plan.source;
    dto.copied_from = plan.copiedFrom;
    dto.items = plan.items.map(MealItemResponseDto.fromDomain);
    dto.created_at = plan.createdAt.toISOString();
    dto.updated_at = plan.updatedAt.toISOString();
    return dto;
  }
}

export class CopyWeekSummaryDto {
  @ApiProperty({ example: 5, description: 'Number of meal plans created' })
  plans_created: number;

  @ApiProperty({
    example: 0,
    description: 'Number of meal plans skipped (already existed)',
  })
  plans_skipped: number;
}

export class MealMenuDayDto {
  @ApiProperty({ example: '2026-05-01' })
  date: string;

  @ApiPropertyOptional({ type: MealPlanResponseDto })
  plan: MealPlanResponseDto | null;
}

export class MealMenuWeekResponseDto {
  @ApiProperty({ example: '2026-04-28' })
  week_start: string;

  @ApiProperty({ type: [MealMenuDayDto] })
  days: MealMenuDayDto[];
}
