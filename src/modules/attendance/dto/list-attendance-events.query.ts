import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsISO8601,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ListAttendanceEventsQuery {
  @ApiPropertyOptional({
    example: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    description: 'Filter by child id.',
  })
  @IsOptional()
  @IsUUID()
  childId?: string;

  @ApiPropertyOptional({
    example: 'gggggggg-gggg-gggg-gggg-gggggggggggg',
    description: 'Filter by group id (resolved via child.current_group_id).',
  })
  @IsOptional()
  @IsUUID()
  groupId?: string;

  @ApiPropertyOptional({ example: '2026-05-01T00:00:00Z' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ example: '2026-06-01T00:00:00Z' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ example: 100, description: 'Limit (1–500).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
