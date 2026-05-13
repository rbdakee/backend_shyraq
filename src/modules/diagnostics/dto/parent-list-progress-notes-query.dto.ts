import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

/**
 * Parent-facing query DTO for `GET /parent/children/:childId/progress-notes`
 * (BP §8.5 / endpoints.md §4.10).
 *
 * Dedicated DTO closes B22b T5 / B18 L3 — `ListProgressNotesQueryDto`
 * (the staff variant) exposes `child_id` and `mentor_id` filters in the
 * parent Swagger contract. Same rationale as the diagnostics-entry
 * variant: the URL `:childId` already pins the child, and `mentor_id` is
 * staff terminology with no parent surface. Drops them here so the
 * parent OpenAPI contract is honest about what the handler actually
 * uses.
 */
export class ParentListProgressNotesQueryDto {
  @ApiProperty({
    example: '2026-01-01',
    description: 'Inclusive lower bound on noted_at date (YYYY-MM-DD).',
    required: false,
  })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiProperty({
    example: '2026-12-31',
    description: 'Inclusive upper bound on noted_at date (YYYY-MM-DD).',
    required: false,
  })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiProperty({
    example: 'eyJpZCI6InV1aWQifQ==',
    description: 'Cursor from previous page next_cursor.',
    required: false,
  })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiProperty({
    example: 20,
    description: 'Page size (default 20, max 100).',
    required: false,
    minimum: 1,
    maximum: 100,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  limit?: number;
}
