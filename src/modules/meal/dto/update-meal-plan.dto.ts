import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { MultiLangTextDto } from './create-meal-item.dto';

export class UpdateMealPlanDto {
  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  is_published?: boolean;

  @ApiPropertyOptional({ type: MultiLangTextDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => MultiLangTextDto)
  notes?: MultiLangTextDto;
}
