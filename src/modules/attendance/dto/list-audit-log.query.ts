import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Paging for `GET /admin/attendance-events/:eventId/history`. Matches the
 * limit/offset convention of the other attendance admin lists.
 */
export class ListAuditLogQuery {
  @ApiPropertyOptional({
    example: 50,
    description: 'Max entries to return. Defaults to the repository default.',
  })
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
