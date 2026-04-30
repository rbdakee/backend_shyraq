import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Per-kindergarten breakdown returned by `runWeeklyRollout`. `error`
 * carries the message of the *first* failure encountered for the kg —
 * the rollout never aborts the whole run on a single-kg failure.
 */
export class RolloutKindergartenItemDto {
  @ApiProperty({ example: 'f1a2b3c4-0000-0000-0000-000000000001' })
  kindergartenId!: string;

  @ApiProperty({ example: 'Demo Kindergarten' })
  name!: string;

  @ApiProperty({
    example: { copiedGroups: 3, skippedGroups: 1, totalEvents: 24 },
    description: 'Result of ScheduleService.copyWeekToNext for this kg.',
  })
  schedule!: {
    copiedGroups: number;
    skippedGroups: number;
    totalEvents: number;
  };

  @ApiProperty({
    example: { plansCreated: 5, plansSkipped: 0 },
    description: 'Result of MealService.copyWeekMenuToNext for this kg.',
  })
  meal!: { plansCreated: number; plansSkipped: number };

  @ApiPropertyOptional({
    example: null,
    nullable: true,
    description:
      'First error message encountered while rolling out this kg. When non-null, the kg counters above may be partial.',
  })
  error!: string | null;
}

export class RolloutTotalsDto {
  @ApiProperty({ example: 5, description: 'Active kindergartens processed.' })
  kindergartens!: number;

  @ApiProperty({ example: 12 })
  copiedGroups!: number;

  @ApiProperty({ example: 3 })
  skippedGroups!: number;

  @ApiProperty({ example: 90 })
  totalEvents!: number;

  @ApiProperty({ example: 24 })
  plansCreated!: number;

  @ApiProperty({ example: 1 })
  plansSkipped!: number;

  @ApiProperty({
    example: 0,
    description: 'Number of kindergartens that hit at least one error.',
  })
  errors!: number;
}

export class RolloutSummaryResponseDto {
  @ApiProperty({
    example: '2026-04-27',
    description:
      'Source-week Monday (YYYY-MM-DD, UTC). Target events land on +7 days.',
  })
  fromMonday!: string;

  @ApiProperty({ example: 'manual', enum: ['manual', 'cron'] })
  source!: 'manual' | 'cron';

  @ApiProperty({ type: [RolloutKindergartenItemDto] })
  kindergartens!: RolloutKindergartenItemDto[];

  @ApiProperty({ type: RolloutTotalsDto })
  totals!: RolloutTotalsDto;
}
