import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export class ListDiagnosticEntriesQueryDto {
  @ApiProperty({
    example: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    description: 'Filter by child.',
    required: false,
  })
  @IsOptional()
  @IsUUID()
  child_id?: string;

  @ApiProperty({
    example: 'bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb',
    description: 'Filter by specialist (staff_member_id).',
    required: false,
  })
  @IsOptional()
  @IsUUID()
  specialist_id?: string;

  @ApiProperty({
    example: 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
    description: 'Filter by template.',
    required: false,
  })
  @IsOptional()
  @IsUUID()
  template_id?: string;

  @ApiProperty({
    example: '2026-01-01',
    description: 'Inclusive lower bound on assessment_date (YYYY-MM-DD).',
    required: false,
  })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiProperty({
    example: '2026-12-31',
    description: 'Inclusive upper bound on assessment_date (YYYY-MM-DD).',
    required: false,
  })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiProperty({
    example: 'eyJpZCI6InV1aWQifQ==',
    description: 'Cursor from previous page next_cursor.',
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
}
