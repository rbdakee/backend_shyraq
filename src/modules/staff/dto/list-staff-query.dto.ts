import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional, IsString } from 'class-validator';
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

export class ListStaffQueryDto {
  @ApiPropertyOptional({ enum: STAFF_ROLES })
  @IsOptional()
  @IsEnum(STAFF_ROLES)
  role?: StaffRole;

  @ApiPropertyOptional({ description: 'Filter by is_active.' })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return value as unknown;
  })
  @IsBoolean()
  is_active?: boolean;

  @ApiPropertyOptional({ enum: SPECIALIST_TYPES })
  @IsOptional()
  @IsEnum(SPECIALIST_TYPES)
  specialist_type?: SpecialistType;

  @ApiPropertyOptional({
    description:
      'Show only archived rows when true; only non-archived when false.',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return value as unknown;
  })
  @IsBoolean()
  archived?: boolean;

  @ApiPropertyOptional({
    description: 'Substring match against full_name / phone (ILIKE).',
  })
  @IsOptional()
  @IsString()
  search?: string;
}
