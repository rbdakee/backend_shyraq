import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { SpecialistType } from '../domain/value-objects/specialist-type.vo';
import { StaffRole } from '../domain/entities/staff-member.entity';

const STAFF_ROLES: readonly StaffRole[] = [
  'admin',
  'mentor',
  'specialist',
  'reception',
];

export class UpdateStaffDto {
  @ApiPropertyOptional({ example: 'Айша Нурланова' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  full_name?: string;

  @ApiPropertyOptional({ enum: STAFF_ROLES, example: 'admin' })
  @IsOptional()
  @IsEnum(STAFF_ROLES)
  role?: StaffRole;

  @ApiPropertyOptional({
    example: 'psychologist',
    nullable: true,
    description:
      'Specialist-type code (null to clear). When set on a role=specialist member, must be an ACTIVE directory code (GET /admin/specialist-types) — else 400 specialist_type_unknown.',
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  specialist_type?: SpecialistType | null;

  @ApiPropertyOptional({ example: '2026-04-24', nullable: true })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsDateString()
  hired_at?: string | null;

  @ApiPropertyOptional({ example: '2026-10-01', nullable: true })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsDateString()
  fired_at?: string | null;
}
