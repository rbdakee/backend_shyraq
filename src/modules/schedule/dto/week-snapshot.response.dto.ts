import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ScheduleWeekSnapshotResponseDto {
  @ApiProperty({ example: 's1a2b3c4-0000-0000-0000-000000000001' })
  id!: string;

  @ApiProperty({ example: 'f1a2b3c4-0000-0000-0000-000000000001' })
  kindergartenId!: string;

  @ApiProperty({ example: 'a1b2c3d4-0000-0000-0000-000000000010' })
  groupId!: string;

  @ApiProperty({ example: '2026-05-04' })
  weekStartDate!: string;

  @ApiProperty({ example: 'manual', enum: ['manual', 'cron'] })
  source!: string;

  @ApiPropertyOptional({
    example: null,
    nullable: true,
    description: 'Snapshot id this week was copied from, when applicable.',
  })
  copiedFrom!: string | null;

  @ApiProperty({ example: '2026-04-30T10:00:00.000Z' })
  createdAt!: string;
}

export class WeekCopySummaryDto {
  @ApiProperty({
    example: 3,
    description: 'Groups for which a fresh snapshot+events were created.',
  })
  copiedGroups!: number;

  @ApiProperty({
    example: 1,
    description:
      'Groups skipped because a snapshot for the target week already exists.',
  })
  skippedGroups!: number;

  @ApiProperty({
    example: 24,
    description: 'Total activity_events written across all copied groups.',
  })
  totalEvents!: number;
}
