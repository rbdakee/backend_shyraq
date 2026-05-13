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
 * Parent-facing query DTO for `GET /parent/children/:childId/diagnostics`
 * (BP §8.5 / endpoints.md §4.10).
 *
 * Dedicated DTO closes B22b T5 / B18 L3 — the parent controller used to
 * accept the staff-shaped `ListDiagnosticEntriesQueryDto` which surfaced
 * `child_id`, `specialist_id`, and `template_id` filters in the parent
 * Swagger contract. Those fields are nonsensical on the parent surface:
 *   - `child_id` is already pinned by the URL `:childId`;
 *   - `specialist_id` is an internal staff identifier the parent has no
 *     reason to filter on (and would also be a small enumeration vector
 *     across kindergarten staff);
 *   - `template_id` is admin/staff terminology — parents see template
 *     names, not ids.
 *
 * Keeping a parent-only DTO ensures the OpenAPI contract Pure-parent
 * consumers see in the docs matches the actual handler behaviour: only
 * date filters + cursor + limit. Validator-side this also rejects
 * stray staff fields with `whitelist: true` global pipe semantics
 * (additional properties are stripped).
 */
export class ParentListDiagnosticEntriesQueryDto {
  @ApiProperty({
    example: '2026-01-01',
    description: 'Inclusive lower bound on assessment_date (YYYY-MM-DD).',
    required: false,
  })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiProperty({
    example: '2026-12-31',
    description: 'Inclusive upper bound on assessment_date (YYYY-MM-DD).',
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
