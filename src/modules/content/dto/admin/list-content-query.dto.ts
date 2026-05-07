import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export class ListContentQueryDto {
  @ApiProperty({
    example: 'news',
    enum: ['news', 'menu', 'schedule_pub', 'qundylyq', 'birthday'],
    description: 'Filter by content type.',
    required: false,
  })
  @IsOptional()
  @IsIn(['news', 'menu', 'schedule_pub', 'qundylyq', 'birthday'])
  content_type?: string;

  @ApiProperty({
    example: 'draft',
    enum: ['draft', 'scheduled', 'published'],
    description: 'Filter by status.',
    required: false,
  })
  @IsOptional()
  @IsIn(['draft', 'scheduled', 'published'])
  status?: string;

  @ApiProperty({
    example: 'all',
    enum: ['all', 'group', 'child'],
    description: 'Filter by target type.',
    required: false,
  })
  @IsOptional()
  @IsIn(['all', 'group', 'child'])
  target_type?: string;

  @ApiProperty({
    example: '550e8400-e29b-41d4-a716-446655440000',
    description: 'Filter by target group id.',
    required: false,
  })
  @IsOptional()
  @IsUUID()
  target_group_id?: string;

  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    description: 'Filter by target child id.',
    required: false,
  })
  @IsOptional()
  @IsUUID()
  target_child_id?: string;

  @ApiProperty({
    example: '2026-05-01T00:00:00.000Z',
    description: 'Filter posts scheduled at or after this ISO-8601 timestamp.',
    required: false,
  })
  @IsOptional()
  @IsISO8601()
  scheduled_from?: string;

  @ApiProperty({
    example: '2026-05-31T23:59:59.000Z',
    description: 'Filter posts scheduled at or before this ISO-8601 timestamp.',
    required: false,
  })
  @IsOptional()
  @IsISO8601()
  scheduled_to?: string;

  @ApiProperty({
    example: '2026-05-01T00:00:00.000Z',
    description: 'Filter posts published at or after this ISO-8601 timestamp.',
    required: false,
  })
  @IsOptional()
  @IsISO8601()
  published_from?: string;

  @ApiProperty({
    example: '2026-05-31T23:59:59.000Z',
    description: 'Filter posts published at or before this ISO-8601 timestamp.',
    required: false,
  })
  @IsOptional()
  @IsISO8601()
  published_to?: string;

  @ApiProperty({
    example: 'eyJpZCI6IjEyMyJ9',
    description: 'Opaque cursor for pagination (from previous response).',
    required: false,
  })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiProperty({
    example: 20,
    description: 'Page size. Min 1, max 100. Default 20.',
    required: false,
    default: 20,
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}
