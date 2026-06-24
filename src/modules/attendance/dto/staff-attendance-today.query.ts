import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsUUID } from 'class-validator';

/**
 * Query params for GET /staff/attendance/today.
 *
 * Both fields are optional at the DTO level; the role-based requirement
 * (mentor MUST supply a `groupId` they are actively assigned to) is enforced
 * in the controller, not by validation, so specialist/reception can omit it
 * for a whole-kindergarten summary.
 */
export class StaffAttendanceTodayQuery {
  @ApiPropertyOptional({
    example: 'a1b2c3d4-0000-0000-0000-000000000001',
    description:
      "Scope the summary to one group (children's current_group_id). " +
      'REQUIRED for mentors (must be a group they are actively assigned to); ' +
      'optional for specialist/reception (omitted → whole-kindergarten).',
  })
  @IsOptional()
  @IsUUID()
  groupId?: string;

  @ApiPropertyOptional({
    example: '2026-06-24',
    description:
      'ISO date YYYY-MM-DD. Defaults to the current Asia/Almaty calendar day.',
  })
  @IsOptional()
  @IsDateString()
  date?: string;
}
