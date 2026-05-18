import { ApiProperty } from '@nestjs/swagger';

/**
 * GET /admin/dashboard/attendance-today — aggregate donut counts for one day.
 *
 * Semantics (documented assumption, see DASHBOARD_BACKEND_PLAN §2.3, §8 —
 * surfaced in PR for frontend sign-off):
 *  - in_kindergarten  last attendance_event of the day = check_in
 *  - checked_out       last attendance_event of the day = check_out
 *  - absent            child_daily_status.status='absent' AND no check_in event that day
 *  - on_vacation       child_daily_status.status='on_vacation'
 *  - sick              child_daily_status.status='sick'
 *  late/early_pickup have no own bucket — if a check_in exists they fall into
 *  in_kindergarten/checked_out by the last-event rule; otherwise uncounted.
 */
export class AttendanceTodayResponseDto {
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
}
