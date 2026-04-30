import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsOptional,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CreateMealItemDto, MultiLangTextDto } from './create-meal-item.dto';

export class CreateMealPlanDto {
  @ApiProperty({
    example: '2026-05-01',
    description: 'Date of the meal plan (YYYY-MM-DD)',
  })
  @IsDateString()
  date: string;

  @ApiPropertyOptional({
    example: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
    description: 'Group UUID (null = kg-wide menu)',
  })
  @IsOptional()
  @IsUUID()
  group_id?: string;

  @ApiPropertyOptional({ example: true, description: 'Publish immediately' })
  @IsOptional()
  @IsBoolean()
  is_published?: boolean;

  @ApiPropertyOptional({
    type: MultiLangTextDto,
    example: { ru: 'Праздничное меню' },
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => MultiLangTextDto)
  notes?: MultiLangTextDto;

  @ApiPropertyOptional({ type: [CreateMealItemDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateMealItemDto)
  items?: CreateMealItemDto[];
}
