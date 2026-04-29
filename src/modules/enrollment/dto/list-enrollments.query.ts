import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  ENROLLMENT_STATUS_VALUES,
  EnrollmentStatusValue,
} from '../domain/value-objects/enrollment-status.vo';

export class ListEnrollmentsQuery {
  @ApiPropertyOptional({
    enum: ENROLLMENT_STATUS_VALUES,
  })
  @IsOptional()
  @IsIn(ENROLLMENT_STATUS_VALUES)
  status?: EnrollmentStatusValue;

  @ApiPropertyOptional({ example: 'Алия' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  q?: string;

  @ApiPropertyOptional({ example: 1, default: 1 })
  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ example: 20, default: 20 })
  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
