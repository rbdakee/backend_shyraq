import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';

/**
 * Query DTO for `GET /parent/children/:childId/daily-status`.
 *
 * Validates the optional `date` parameter (YYYY-MM-DD). T6 M1 fix-pass —
 * previously the controller read the raw string and let an invalid value
 * propagate to PostgreSQL, which crashed with `invalid input syntax for
 * type date`.
 */
export class ParentDailyStatusQuery {
  @ApiPropertyOptional({
    example: '2026-05-01',
    description:
      'ISO date YYYY-MM-DD. Defaults to today in Asia/Almaty timezone.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date?: string;
}
