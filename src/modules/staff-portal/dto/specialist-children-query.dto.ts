import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

/**
 * Query for the specialist child-picker (`GET /staff/children`).
 *
 * `specialist_scope` is retained per the mobile contract even though the route
 * is specialist-only (the guard chain already restricts callers to the
 * `specialist` role). The list is always scoped to ALL active children of the
 * caller's kindergarten; the flag does not change the result set today but is
 * kept so the client can pass it explicitly. Pagination is opaque-cursor based,
 * identical to the roster.
 */
export class SpecialistChildrenQueryDto {
  @ApiPropertyOptional({
    description:
      'Mobile contract flag — request the kindergarten-wide active-children ' +
      'scope for specialist diagnostics. The route is specialist-only, so the ' +
      'scope is always applied regardless of value.',
    example: true,
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return value as unknown;
  })
  @IsBoolean()
  specialist_scope?: boolean;

  @ApiPropertyOptional({
    description:
      'Opaque pagination cursor returned as `next_cursor` by the previous ' +
      'page. Omit for the first page. Malformed values are rejected with 400.',
    example: 'MjA',
  })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({
    description: 'Page size. Default 20, maximum 100.',
    example: 20,
    minimum: 1,
    maximum: 100,
    default: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
