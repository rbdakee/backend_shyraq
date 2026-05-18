import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID, Matches } from 'class-validator';

/**
 * GET /admin/dashboard/attendance-today query.
 *
 * NOTE: the group filter param is snake_case `group_id` (NOT `groupId`) —
 * this is the documented contract (endpoints.md §2.22). attendance_events has
 * no group_id column, so the filter resolves through children.current_group_id.
 */
export class AttendanceTodayQuery {
  @ApiPropertyOptional({
    name: 'group_id',
    example: 'a1b2c3d4-0000-0000-0000-000000000001',
    description: 'Optional group filter (children.current_group_id).',
  })
  @IsOptional()
  @IsUUID()
  group_id?: string;

  @ApiPropertyOptional({
    example: '2026-05-18',
    description: 'Date override YYYY-MM-DD. Defaults to today in Asia/Almaty.',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date?: string;
}
