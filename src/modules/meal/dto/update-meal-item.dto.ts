import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  MEAL_TYPE_VALUES,
  MealTypeValue,
  MultiLangTextDto,
} from './create-meal-item.dto';

export class UpdateMealItemDto {
  @ApiPropertyOptional({ enum: MEAL_TYPE_VALUES, example: 'lunch' })
  @IsOptional()
  @IsEnum(MEAL_TYPE_VALUES)
  meal_type?: MealTypeValue;

  @ApiPropertyOptional({ type: MultiLangTextDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => MultiLangTextDto)
  dish_name?: MultiLangTextDto;

  @ApiPropertyOptional({ type: MultiLangTextDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => MultiLangTextDto)
  description?: MultiLangTextDto;

  @ApiPropertyOptional({ type: [String], example: ['gluten'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allergens?: string[];

  @ApiPropertyOptional({ example: 'https://cdn.example.com/meal.jpg' })
  @IsOptional()
  @IsString()
  photo_url?: string;

  @ApiPropertyOptional({ example: 350 })
  @IsOptional()
  @IsInt()
  @Min(0)
  calories?: number;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;
}
