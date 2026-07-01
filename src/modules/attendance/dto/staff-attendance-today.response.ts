import { ApiProperty } from '@nestjs/swagger';

/**
 * GET /staff/attendance/today — aggregate donut counts for one Asia/Almaty
 * calendar day, scoped to the caller's kindergarten (optionally a single
 * group). Same composition as the admin dashboard attendance-today aggregate,
 * plus an explicit `late` bucket.
 *
 * Semantics:
 *  - in_kindergarten  last attendance_event of the day = check_in
 *  - checked_out       last attendance_event of the day = check_out
 *  - absent            child_daily_status.status='absent' AND no check_in event that day
 *  - on_vacation       child_daily_status.status='on_vacation'
 *  - sick              child_daily_status.status='sick'
 *  - late              child_daily_status.status='late'
 */
export class StaffAttendanceTodayResponseDto {
  @ApiProperty({
    example: 42,
    description: 'Children whose last event today is check_in.',
  })
  in_kindergarten!: number;

  @ApiProperty({
    example: 7,
    description: 'Children whose last event today is check_out.',
  })
  checked_out!: number;

  @ApiProperty({
    example: 5,
    description: "daily_status='absent' AND no check_in event that day.",
  })
  absent!: number;

  @ApiProperty({
    example: 3,
    description: "daily_status='on_vacation'.",
  })
  on_vacation!: number;

  @ApiProperty({
    example: 2,
    description: "daily_status='sick'.",
  })
  sick!: number;

  @ApiProperty({
    example: 4,
    description: "daily_status='late'.",
  })
  late!: number;
}
