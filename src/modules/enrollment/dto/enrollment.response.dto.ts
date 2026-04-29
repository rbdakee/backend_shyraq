import { ApiProperty } from '@nestjs/swagger';
import {
  ENROLLMENT_STATUS_VALUES,
  EnrollmentStatusValue,
} from '../domain/value-objects/enrollment-status.vo';

export class EnrollmentResponseDto {
  @ApiProperty({ example: 'e1a2b3c4-0000-0000-0000-000000000001' })
  id!: string;

  @ApiProperty({ example: 'f1a2b3c4-0000-0000-0000-000000000001' })
  kindergartenId!: string;

  @ApiProperty({
    example: null,
    nullable: true,
    description: 'Populated after card_created transition.',
  })
  childId!: string | null;

  @ApiProperty({ example: 'Айгуль Серикова' })
  contactName!: string;

  @ApiProperty({ example: '+77011112233' })
  contactPhone!: string;

  @ApiProperty({ example: 'Алия Серикова', nullable: true })
  childName!: string | null;

  @ApiProperty({
    example: '2021-08-15',
    nullable: true,
    description: 'ISO date YYYY-MM-DD',
  })
  childDob!: string | null;

  @ApiProperty({ example: '210815500123', nullable: true })
  childIin!: string | null;

  @ApiProperty({ enum: ENROLLMENT_STATUS_VALUES, example: 'new' })
  status!: EnrollmentStatusValue;

  @ApiProperty({ example: 'instagram_ad', nullable: true })
  source!: string | null;

  @ApiProperty({ example: 'Хочет с октября 2026', nullable: true })
  notes!: string | null;

  @ApiProperty({
    example: 'b2a1c0d9-0000-0000-0000-000000000001',
    nullable: true,
  })
  assignedTo!: string | null;

  @ApiProperty({ example: '2026-04-30T10:00:00.000Z' })
  statusChangedAt!: string;

  @ApiProperty({ example: '2026-04-30T10:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ example: '2026-04-30T10:00:00.000Z' })
  updatedAt!: string;
}

/**
 * Reusable response example for T6 controller @ApiResponse decorators.
 */
export const enrollmentResponseExample: EnrollmentResponseDto = {
  id: 'e1a2b3c4-0000-0000-0000-000000000001',
  kindergartenId: 'f1a2b3c4-0000-0000-0000-000000000001',
  childId: null,
  contactName: 'Айгуль Серикова',
  contactPhone: '+77011112233',
  childName: 'Алия Серикова',
  childDob: '2021-08-15',
  childIin: '210815500123',
  status: 'new',
  source: 'instagram_ad',
  notes: 'Хочет с октября 2026',
  assignedTo: 'b2a1c0d9-0000-0000-0000-000000000001',
  statusChangedAt: '2026-04-30T10:00:00.000Z',
  createdAt: '2026-04-30T10:00:00.000Z',
  updatedAt: '2026-04-30T10:00:00.000Z',
};

export class EnrollmentListResponseDto {
  @ApiProperty({ type: [EnrollmentResponseDto] })
  data!: EnrollmentResponseDto[];

  @ApiProperty({ example: 42 })
  total!: number;

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  limit!: number;
}
