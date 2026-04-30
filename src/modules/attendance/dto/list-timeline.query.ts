import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ListTimelineQuery {
  @ApiPropertyOptional({
    example: 50,
    description: 'Max items per page (1–200). Defaults to 50.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({
    description: 'Opaque cursor from previous page nextCursor.',
  })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({
    example: '2026-05-01T00:00:00Z',
    description: 'Inclusive lower bound on entry_time (ISO 8601).',
  })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({
    example: '2026-06-01T00:00:00Z',
    description: 'Exclusive upper bound on entry_time (ISO 8601).',
  })
  @IsOptional()
  @IsISO8601()
  to?: string;
}
