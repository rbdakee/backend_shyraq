import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ATTENDANCE_EVENT_TYPE_VALUES,
  AttendanceEventTypeValue,
} from '../domain/value-objects/attendance-event-type.vo';
import {
  ATTENDANCE_METHOD_VALUES,
  AttendanceMethodValue,
} from '../domain/value-objects/attendance-method.vo';

export class AttendanceEventResponseDto {
  @ApiProperty({ example: 'e1111111-1111-1111-1111-111111111111' })
  id!: string;

  @ApiProperty({ example: 'f1a2b3c4-0000-0000-0000-000000000001' })
  kindergartenId!: string;

  @ApiProperty({ example: 'cccccccc-cccc-cccc-cccc-cccccccccccc' })
  childId!: string;

  @ApiPropertyOptional({
    example: 'Алихан Сериков',
    nullable: true,
    description:
      'Display name of the child (identity overlay: children.id → ' +
      'children.full_name within the kindergarten; includes archived ' +
      'children). null when the child row is missing or cross-tenant.',
  })
  child_name!: string | null;

  @ApiProperty({ enum: ATTENDANCE_EVENT_TYPE_VALUES, example: 'check_in' })
  eventType!: AttendanceEventTypeValue;

  @ApiProperty({ enum: ATTENDANCE_METHOD_VALUES, example: 'manual' })
  method!: AttendanceMethodValue;

  @ApiPropertyOptional({
    example: 'sssssssss-ssss-ssss-ssss-ssssssssssss',
    nullable: true,
    description: 'staff_members.id of the recorder.',
  })
  recordedBy!: string | null;

  @ApiPropertyOptional({
    example: 'Айгуль Сатпаева',
    nullable: true,
    description:
      'Display name of the recorder (identity overlay: staff_members.id ' +
      '→ users.full_name). null when recordedBy is absent or the name ' +
      'is empty/whitespace.',
  })
  recorded_by_full_name!: string | null;

  @ApiPropertyOptional({
    example: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    nullable: true,
    description: 'users.id picking up the child (check_out only).',
  })
  pickupUserId!: string | null;

  @ApiPropertyOptional({
    example: 'Бахыт Нурланова',
    nullable: true,
    description:
      'Display name of the pickup user (identity overlay: users.id → ' +
      'users.full_name). null when pickupUserId is absent (non check_out ' +
      'events) or the name is empty/whitespace.',
  })
  pickup_user_full_name!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'pickup_requests.id (B11+); always null in B8.',
  })
  pickupRequestId!: string | null;

  @ApiPropertyOptional({ example: 'Прибыл с папой', nullable: true })
  notes!: string | null;

  @ApiProperty({ example: '2026-05-01T09:00:00.000Z' })
  recordedAt!: string;

  @ApiProperty({ example: '2026-05-01T09:00:01.234Z' })
  createdAt!: string;
}
