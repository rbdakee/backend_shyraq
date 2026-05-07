import { ApiProperty } from '@nestjs/swagger';
import {
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateTariffAssignmentDto {
  @ApiProperty({ example: 'cccccccc-cccc-cccc-cccc-cccccccccccc' })
  @IsUUID()
  child_id!: string;

  @ApiProperty({ example: 'f1a2b3c4-0001-0001-0001-000000000001' })
  @IsUUID()
  tariff_plan_id!: string;

  @ApiProperty({
    example: 90000,
    description:
      'Override amount in KZT. When set, takes precedence over the plan amount.',
    required: false,
    nullable: true,
    minimum: 0,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  custom_amount?: number | null;

  @ApiProperty({
    example: 'Льгота многодетной семьи',
    description: 'Reason for the custom amount override.',
    required: false,
    nullable: true,
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  custom_reason?: string | null;

  @ApiProperty({
    example: '2026-06-01',
    description: 'ISO date (YYYY-MM-DD) from which the assignment is valid.',
  })
  @IsDateString()
  valid_from!: string;

  @ApiProperty({
    example: '2027-05-31',
    description:
      'ISO date (YYYY-MM-DD). Null means open-ended until manually closed.',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsDateString()
  valid_until?: string | null;
}

export class UpdateTariffAssignmentDto {
  @ApiProperty({
    example: 95000,
    description: 'Updated override amount in KZT.',
    required: false,
    nullable: true,
    minimum: 0,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  custom_amount?: number | null;

  @ApiProperty({
    example: 'Пересмотренная льгота',
    required: false,
    nullable: true,
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  custom_reason?: string | null;

  @ApiProperty({
    example: '2026-12-31',
    description: 'ISO date (YYYY-MM-DD). Set to today to close the assignment.',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsDateString()
  valid_until?: string | null;
}

export class TariffAssignmentResponseDto {
  @ApiProperty({ example: 'e2b3c4d5-0002-0002-0002-000000000002' })
  id!: string;

  @ApiProperty({ example: '00000000-0000-0000-0000-000000000001' })
  kindergarten_id!: string;

  @ApiProperty({ example: 'cccccccc-cccc-cccc-cccc-cccccccccccc' })
  child_id!: string;

  @ApiProperty({ example: 'f1a2b3c4-0001-0001-0001-000000000001' })
  tariff_plan_id!: string;

  @ApiProperty({
    example: 90000,
    nullable: true,
    description: 'Custom override amount in KZT. Null means plan amount used.',
  })
  custom_amount!: number | null;

  @ApiProperty({
    example: 'Льгота многодетной семьи',
    nullable: true,
  })
  custom_reason!: string | null;

  @ApiProperty({ example: '2026-06-01' })
  valid_from!: string;

  @ApiProperty({ example: '2027-05-31', nullable: true })
  valid_until!: string | null;

  @ApiProperty({ example: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' })
  assigned_by!: string;

  @ApiProperty({ example: '2026-05-01T09:00:00.000Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-05-01T09:00:00.000Z' })
  updated_at!: string;
}

export class ListTariffAssignmentsQueryDto {
  @ApiProperty({
    example: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    description: 'Filter assignments for a specific child.',
    required: false,
  })
  @IsOptional()
  @IsUUID()
  child_id?: string;

  @ApiProperty({
    example: 'f1a2b3c4-0001-0001-0001-000000000001',
    description: 'Filter by tariff plan.',
    required: false,
  })
  @IsOptional()
  @IsUUID()
  tariff_plan_id?: string;

  @ApiProperty({
    example: '2026-06-15',
    description:
      'ISO date (YYYY-MM-DD). Returns assignments active on this date (valid_from <= date <= valid_until or open-ended).',
    required: false,
  })
  @IsOptional()
  @IsDateString()
  active_on?: string;
}
