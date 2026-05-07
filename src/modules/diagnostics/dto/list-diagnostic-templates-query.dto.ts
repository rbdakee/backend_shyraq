import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class ListDiagnosticTemplatesQueryDto {
  @ApiProperty({
    example: 'speech_therapist',
    description: 'Filter by specialist_type.',
    required: false,
  })
  @IsOptional()
  @IsString()
  specialist_type?: string;

  @ApiProperty({
    example: true,
    description:
      'Filter by active status. Omit to return all. Parsed from "true"/"false" string.',
    required: false,
  })
  @IsOptional()
  @Transform(({ value }) => value === 'true')
  @IsBoolean()
  is_active?: boolean;

  @ApiProperty({
    example: 'eyJpZCI6InV1aWQifQ==',
    description:
      'Cursor from previous page next_cursor. Pass back to get next page.',
    required: false,
  })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiProperty({
    example: 20,
    description: 'Page size (default 20, max 100).',
    required: false,
    minimum: 1,
    maximum: 100,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  limit?: number;

  /**
   * Staff endpoint only: admin callers pass `all=true` to bypass the
   * specialist_type scope filter and see all templates.
   */
  @ApiProperty({
    example: false,
    description:
      'Admin-only: pass true to bypass specialist_type filter and list all templates.',
    required: false,
  })
  @IsOptional()
  @Transform(({ value }) => value === 'true')
  @IsBoolean()
  all?: boolean;
}
