import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * Query for the cursor-paginated group roster
 * (`GET /staff/my-groups/:groupId/children`).
 *
 * Pagination is opaque-cursor based: `cursor` is the black-box token returned
 * as `next_cursor` by the previous page (it decodes to an internal offset).
 * `limit` defaults to 20 and is capped at 100.
 */
export class RosterQueryDto {
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
