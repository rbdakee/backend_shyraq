import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  SPECIALIST_TYPES,
  SpecialistType,
} from '../domain/value-objects/specialist-type.vo';
import { StaffRole } from '../domain/entities/staff-member.entity';

const STAFF_ROLES: readonly StaffRole[] = [
  'admin',
  'mentor',
  'specialist',
  'reception',
];

export class CreateStaffDto {
  @ApiProperty({ example: 'Айша Нурланова' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  full_name!: string;

  @ApiProperty({ example: '+77011112233' })
  @IsString()
  @Matches(/^\+[1-9]\d{1,14}$/, { message: 'phone must be E.164' })
  phone!: string;

  @ApiProperty({ enum: STAFF_ROLES, example: 'mentor' })
  @IsEnum(STAFF_ROLES)
  role!: StaffRole;

  @ApiPropertyOptional({ enum: SPECIALIST_TYPES, example: 'psychologist' })
  @IsOptional()
  @IsEnum(SPECIALIST_TYPES)
  specialist_type?: SpecialistType;

  @ApiPropertyOptional({ example: '2026-04-24' })
  @IsOptional()
  @IsDateString()
  hired_at?: string;
}
