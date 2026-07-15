import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

export class RebuildWeekSnapshotsDto {
  @ApiPropertyOptional({
    example: 'a1b2c3d4-0000-0000-0000-000000000010',
    nullable: true,
    description:
      'Narrow the rebuild to a single group. Omit (or send null) to rebuild every group of this kindergarten — which is what a kindergarten-wide template (group_id = null) requires.',
  })
  @IsOptional()
  @IsUUID()
  groupId?: string;
}

export class RematerializeSummaryDto {
  @ApiProperty({
    example: 2,
    description:
      'Distinct (group, week) pairs re-projected — one per already-materialized week from the current ISO week forward.',
  })
  rebuiltWeeks!: number;

  @ApiProperty({
    example: 76,
    description:
      "Stale template-projected events removed (origin='template', status='scheduled', starts_at > now). Ad-hoc events and anything already started or past are never counted here.",
  })
  deletedEvents!: number;

  @ApiProperty({
    example: 76,
    description:
      'Fresh events written from the current template definitions (only those starting after now).',
  })
  insertedEvents!: number;
}
