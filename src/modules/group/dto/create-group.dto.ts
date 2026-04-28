import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateGroupDto {
  @ApiProperty({
    example: 'Sunshine',
    description: 'Group name — must not be blank.',
    minLength: 1,
    maxLength: 255,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @ApiProperty({
    example: 20,
    description: 'Maximum number of children in the group.',
    minimum: 1,
  })
  @IsInt()
  @Min(1)
  capacity!: number;

  @ApiPropertyOptional({
    example: 12,
    description: 'Lower bound of group age range (months).',
    minimum: 0,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  age_range_min?: number;

  @ApiPropertyOptional({
    example: 36,
    description:
      'Upper bound of group age range (months). Must be strictly greater than age_range_min if both are provided.',
    minimum: 0,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  age_range_max?: number;

  @ApiPropertyOptional({
    example: 'a1b2c3d4-1234-5678-abcd-1234567890ab',
    description: 'UUID of the current location (must belong to the tenant).',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  current_location_id?: string;
}
