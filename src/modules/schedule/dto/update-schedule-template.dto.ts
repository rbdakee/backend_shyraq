import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class UpdateScheduleTemplateDto {
  @ApiPropertyOptional({ example: 'Renamed' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    example: '2026-09-01',
    description: 'ISO date YYYY-MM-DD; explicit null clears the bound.',
  })
  @IsOptional()
  @IsDateString()
  validUntil?: string | null;
}
