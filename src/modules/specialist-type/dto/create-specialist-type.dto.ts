import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  Matches,
} from 'class-validator';

export class CreateSpecialistTypeDto {
  @ApiProperty({
    example: 'art_therapist',
    description:
      'Immutable machine code — lowercase snake_case, letter-led, 2–64 chars. Unique per kindergarten.',
  })
  @Matches(/^[a-z][a-z0-9_]{1,63}$/, {
    message: 'code must be lowercase snake_case (letter-led, 2–64 chars)',
  })
  code!: string;

  @ApiProperty({
    example: { ru: 'Арт-терапевт', kk: 'Арт-терапевт' },
    description:
      'Localised labels object. At least one of `ru` / `kk` must be a non-empty string.',
    type: Object,
  })
  @IsObject()
  name_i18n!: Record<string, string>;

  @ApiPropertyOptional({ example: true, default: true })
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  @ApiPropertyOptional({
    example: 100,
    description: 'Ascending display order. Defaults after the system rows.',
  })
  @IsOptional()
  @IsInt()
  sort_order?: number;
}
