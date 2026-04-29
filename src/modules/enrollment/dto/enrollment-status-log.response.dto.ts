import { ApiProperty } from '@nestjs/swagger';
import {
  ENROLLMENT_STATUS_VALUES,
  EnrollmentStatusValue,
} from '../domain/value-objects/enrollment-status.vo';
import { EnrollmentResponseDto } from './enrollment.response.dto';

export class EnrollmentStatusLogResponseDto {
  @ApiProperty({ example: 'a1b2c3d4-0000-0000-0000-000000000001' })
  id!: string;

  @ApiProperty({ example: 'e1a2b3c4-0000-0000-0000-000000000001' })
  enrollmentId!: string;

  @ApiProperty({ example: 'f1a2b3c4-0000-0000-0000-000000000001' })
  kindergartenId!: string;

  @ApiProperty({
    enum: ENROLLMENT_STATUS_VALUES,
    example: null,
    nullable: true,
    description: 'Null for the initial creation log entry.',
  })
  fromStatus!: EnrollmentStatusValue | null;

  @ApiProperty({ enum: ENROLLMENT_STATUS_VALUES, example: 'new' })
  toStatus!: EnrollmentStatusValue;

  @ApiProperty({
    example: 'b2a1c0d9-0000-0000-0000-000000000001',
    description: 'staff_members.id UUID',
  })
  changedBy!: string;

  @ApiProperty({ example: 'Звонила, родитель готов оформить', nullable: true })
  comment!: string | null;

  @ApiProperty({ example: '2026-04-30T10:00:00.000Z' })
  createdAt!: string;
}

/**
 * Composite response for GET /enrollments/:id — returns the enrollment record
 * together with its full status-change audit trail. T6 uses this as the
 * response shape for the detail endpoint.
 */
export class EnrollmentDetailResponseDto {
  @ApiProperty({ type: EnrollmentResponseDto })
  enrollment!: EnrollmentResponseDto;

  @ApiProperty({ type: [EnrollmentStatusLogResponseDto] })
  log!: EnrollmentStatusLogResponseDto[];
}
