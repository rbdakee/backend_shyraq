import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, Matches } from 'class-validator';

/**
 * GET /admin/dashboard/payments-overview query.
 *
 * `from`/`to` are required inclusive YYYY-MM-DD calendar dates. The
 * cross-field `to >= from` rule is enforced in DashboardService (it needs a
 * comparison across two fields) and surfaces as 400 `invalid_date_range`.
 */
export class PaymentsOverviewQuery {
  @ApiProperty({
    example: '2026-05-01',
    description: 'Inclusive lower bound (YYYY-MM-DD).',
  })
  @IsDateString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be YYYY-MM-DD' })
  from!: string;

  @ApiProperty({
    example: '2026-05-31',
    description: 'Inclusive upper bound (YYYY-MM-DD). Must be >= from.',
  })
  @IsDateString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must be YYYY-MM-DD' })
  to!: string;
}
