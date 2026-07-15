import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';
import {
  ATTENDANCE_EVENT_TYPE_VALUES,
  AttendanceEventTypeValue,
} from '../domain/value-objects/attendance-event-type.vo';
import { PatchAttendanceDto } from './patch-attendance.dto';

/**
 * Admin PATCH body. Extends the shared staff patch with the two structural
 * corrections reception is not allowed to make.
 *
 * It is a separate class purely so the staff route's Swagger does not
 * advertise fields that would 403 for it — the authorization itself is
 * enforced in `AttendanceService.patchEvent` via the `isAdmin` flag, not by
 * the DTO.
 */
export class AdminPatchAttendanceDto extends PatchAttendanceDto {
  @ApiPropertyOptional({
    example: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    description:
      'Re-point the event at a different child (admin only) — for a record filed against the wrong kid. ' +
      'Cascades: the paired timeline entry moves with it, and daily_status is recomputed for BOTH the old and the new child. ' +
      'On a check_out, the pickup user is re-validated against the new child’s guardians.',
  })
  @IsOptional()
  @IsUUID()
  childId?: string;

  @ApiPropertyOptional({
    enum: ATTENDANCE_EVENT_TYPE_VALUES,
    example: 'check_out',
    description:
      'Flip check_in ⇄ check_out (admin only) — for a mis-pressed button. ' +
      'Flipping to check_in clears pickup_user_id. The paired timeline entry is replaced with one of the correct type.',
  })
  @IsOptional()
  @IsIn(ATTENDANCE_EVENT_TYPE_VALUES)
  eventType?: AttendanceEventTypeValue;
}
