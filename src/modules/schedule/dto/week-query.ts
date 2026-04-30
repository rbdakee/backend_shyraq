import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsUUID } from 'class-validator';

export class StaffWeekQuery {
  @ApiProperty({ example: 'a1b2c3d4-0000-0000-0000-000000000001' })
  @IsUUID()
  groupId!: string;

  @ApiPropertyOptional({
    example: '2026-05-04',
    description:
      'ISO date YYYY-MM-DD — Monday of the week. Defaults to this week.',
  })
  @IsOptional()
  @IsDateString()
  weekStart?: string;
}

export class StaffTodayQuery {
  @ApiProperty({ example: 'a1b2c3d4-0000-0000-0000-000000000001' })
  @IsUUID()
  groupId!: string;
}

export class ParentScheduleQuery {
  @ApiProperty({
    example: '2026-05-04',
    description:
      'ISO date YYYY-MM-DD — inclusive lower bound on starts_at (start of returned range).',
  })
  @IsDateString()
  dateFrom!: string;

  @ApiProperty({
    example: '2026-05-09',
    description:
      'ISO date YYYY-MM-DD — exclusive upper bound on starts_at (end of returned range).',
  })
  @IsDateString()
  dateTo!: string;
}
