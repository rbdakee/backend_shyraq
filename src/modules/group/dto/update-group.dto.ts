import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class UpdateGroupDto {
  @ApiPropertyOptional({
    example: 'Sunshine+',
    description: 'New group name.',
    minLength: 1,
    maxLength: 255,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({
    example: 25,
    description: 'New capacity.',
    minimum: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  capacity?: number;

  @ApiPropertyOptional({
    example: 18,
    description: 'New lower bound of age range (months). Send null to clear.',
    minimum: 0,
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(0)
  age_range_min?: number | null;

  @ApiPropertyOptional({
    example: 48,
    description: 'New upper bound of age range (months). Send null to clear.',
    minimum: 0,
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(0)
  age_range_max?: number | null;

  @ApiPropertyOptional({
    example: 'a1b2c3d4-1234-5678-abcd-1234567890ab',
    description: 'New currentLocation UUID. Send null to clear.',
    format: 'uuid',
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsUUID()
  current_location_id?: string | null;
}
