import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class MultiLangTextDto {
  @ApiProperty({ example: 'Овсяная каша', description: 'Russian name' })
  @IsString()
  ru: string;

  @ApiPropertyOptional({ example: 'Сұлы жармасы' })
  @IsOptional()
  @IsString()
  kk?: string;

  @ApiPropertyOptional({ example: 'Oatmeal' })
  @IsOptional()
  @IsString()
  en?: string;
}

export const MEAL_TYPE_VALUES = [
  'breakfast',
  'snack_am',
  'lunch',
  'snack_pm',
  'dinner',
] as const;
export type MealTypeValue = (typeof MEAL_TYPE_VALUES)[number];

export class CreateMealItemDto {
  @ApiProperty({
    enum: MEAL_TYPE_VALUES,
    example: 'breakfast',
    description: 'Meal type',
  })
  @IsEnum(MEAL_TYPE_VALUES)
  meal_type: MealTypeValue;

  @ApiProperty({
    type: MultiLangTextDto,
    example: { ru: 'Овсяная каша', kk: 'Сұлы жармасы' },
  })
  @ValidateNested()
  @Type(() => MultiLangTextDto)
  dish_name: MultiLangTextDto;

  @ApiPropertyOptional({ type: MultiLangTextDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => MultiLangTextDto)
  description?: MultiLangTextDto;

  @ApiPropertyOptional({
    type: [String],
    example: ['gluten', 'dairy'],
    description: 'Allergen list',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allergens?: string[];

  @ApiPropertyOptional({ example: 'https://cdn.example.com/meal.jpg' })
  @IsOptional()
  @IsString()
  photo_url?: string;

  @ApiPropertyOptional({ example: 350, description: 'Calories (kcal)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  calories?: number;

  @ApiPropertyOptional({ example: '08:30', description: 'Serve time HH:mm' })
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'serve_time must be HH:mm' })
  serve_time?: string;

  @ApiPropertyOptional({ example: 0, description: 'Display order (0 = first)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;
}
