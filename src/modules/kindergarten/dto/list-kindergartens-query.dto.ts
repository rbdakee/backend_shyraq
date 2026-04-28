import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const toBoolean = ({ value }: { value: unknown }): unknown => {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
};

const toInt = ({ value }: { value: unknown }): unknown => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    return parseInt(value, 10);
  }
  return value;
};

export class ListKindergartensQueryDto {
  @ApiPropertyOptional({
    example: 'standard',
    description: 'Filter by tariff plan code.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  plan?: string;

  @ApiPropertyOptional({ example: true, description: 'Filter by active flag.' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  is_active?: boolean;

  @ApiPropertyOptional({
    example: false,
    description:
      'When true returns only archived rows; when false only active ones.',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  archived?: boolean;

  @ApiPropertyOptional({
    example: 'солн',
    description: 'Case-insensitive partial match on name.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name_search?: string;

  @ApiPropertyOptional({ example: 50, default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ example: 0, default: 0, minimum: 0 })
  @IsOptional()
  @Transform(toInt)
  @IsInt()
  @Min(0)
  offset?: number;
}
