import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class CreateScheduleTemplateDto {
  @ApiPropertyOptional({
    example: 'a1b2c3d4-0000-0000-0000-000000000001',
    description: 'Group id; null/omit for kindergarten-wide template.',
  })
  @IsOptional()
  @IsUUID()
  groupId?: string;

  @ApiProperty({ example: 'Standard Mon-Fri' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({ example: 'weekly', default: 'weekly' })
  @IsOptional()
  @IsIn(['weekly'])
  recurrence?: 'weekly';

  @ApiProperty({
    example: '2026-05-04',
    description: 'ISO date YYYY-MM-DD when this template starts being valid.',
  })
  @IsDateString()
  validFrom!: string;

  @ApiPropertyOptional({ example: '2026-09-01' })
  @IsOptional()
  @IsDateString()
  validUntil?: string;

  @ApiPropertyOptional({ example: true, default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
