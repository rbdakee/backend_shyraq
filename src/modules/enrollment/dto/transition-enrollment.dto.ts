import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import {
  ENROLLMENT_STATUS_VALUES,
  EnrollmentStatusValue,
} from '../domain/value-objects/enrollment-status.vo';

export class TransitionEnrollmentDto {
  @ApiProperty({
    enum: ENROLLMENT_STATUS_VALUES,
    example: 'in_processing',
  })
  @IsIn(ENROLLMENT_STATUS_VALUES)
  toStatus!: EnrollmentStatusValue;

  @ApiPropertyOptional({ example: 'Звонила, родитель готов оформить' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string;

  @ApiPropertyOptional({
    example: 'a1b2c3d4-0000-0000-0000-000000000001',
    description:
      'Required by service when toStatus is card_created — must be a valid group UUID.',
  })
  @IsOptional()
  @IsUUID()
  currentGroupId?: string;
}
