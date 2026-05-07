import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsObject,
  IsOptional,
  IsString,
  MinLength,
  ValidateNested,
} from 'class-validator';

class HolidayNameDto {
  @ApiProperty({
    example: 'День Республики',
    description: 'Russian locale name.',
    minLength: 1,
  })
  @IsString()
  @MinLength(1)
  ru!: string;

  @ApiProperty({
    example: 'Республика күні',
    description: 'Kazakh locale name.',
    required: false,
  })
  @IsOptional()
  @IsString()
  kz?: string;

  @ApiProperty({
    example: 'Republic Day',
    description: 'English locale name.',
    required: false,
  })
  @IsOptional()
  @IsString()
  en?: string;
}

export class CreateHolidayDto {
  @ApiProperty({
    example: '2026-10-25',
    description:
      'ISO date (YYYY-MM-DD). Must be unique per kindergarten — 409 on duplicate.',
  })
  @IsDateString()
  date!: string;

  @ApiProperty({
    type: HolidayNameDto,
    description: 'Locale map for the holiday name. At least "ru" is required.',
    example: { ru: 'День Республики', kz: 'Республика күні' },
  })
  @ValidateNested()
  @Type(() => HolidayNameDto)
  name!: HolidayNameDto;

  @ApiProperty({
    example: false,
    description:
      'When false, this day is excluded from pro-rata billing calculations.',
    default: false,
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  is_billable?: boolean;
}

export class UpdateHolidayDto {
  @ApiProperty({
    example: { ru: 'Обновлённое название', kz: 'Жаңартылған атау' },
    description: 'Partial locale map update.',
    required: false,
  })
  @IsOptional()
  @IsObject()
  name?: Record<string, string>;

  @ApiProperty({
    example: true,
    description: 'Update billing exclusion flag.',
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  is_billable?: boolean;
}

export class HolidayResponseDto {
  @ApiProperty({ example: 'h1a2b3c4-0003-0003-0003-000000000003' })
  id!: string;

  @ApiProperty({ example: '00000000-0000-0000-0000-000000000001' })
  kindergarten_id!: string;

  @ApiProperty({
    example: '2026-10-25',
    description: 'Holiday date as ISO date string (YYYY-MM-DD).',
  })
  date!: string;

  @ApiProperty({
    example: { ru: 'День Республики', kz: 'Республика күні' },
    description: 'Locale map of holiday names.',
  })
  name!: Record<string, string>;

  @ApiProperty({
    example: false,
    description: 'Whether the day counts as billable for pro-rata.',
  })
  is_billable!: boolean;

  @ApiProperty({ example: '2026-05-01T09:00:00.000Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-05-01T09:00:00.000Z' })
  updated_at!: string;
}

export class ListHolidaysQueryDto {
  @ApiProperty({
    example: '2026-01-01',
    description: 'Return holidays on or after this ISO date (YYYY-MM-DD).',
    required: false,
  })
  @IsOptional()
  @IsDateString()
  from_date?: string;

  @ApiProperty({
    example: '2026-12-31',
    description: 'Return holidays on or before this ISO date (YYYY-MM-DD).',
    required: false,
  })
  @IsOptional()
  @IsDateString()
  to_date?: string;

  @ApiProperty({
    example: false,
    description: 'Filter by billable flag.',
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  is_billable?: boolean;
}
