import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class ListNotificationsQueryDto {
  @ApiPropertyOptional({
    example: false,
    description: 'When true, return only notifications with read_at IS NULL.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return value;
  })
  unread_only?: boolean;

  @ApiPropertyOptional({
    example: 20,
    description: 'Page size. Min 1, max 100. Default 20.',
    minimum: 1,
    maximum: 100,
    default: 20,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Transform(({ value }) =>
    value !== undefined ? parseInt(value as string, 10) : undefined,
  )
  limit?: number;

  @ApiPropertyOptional({
    example:
      'eyJjcmVhdGVkQXQiOiIyMDI2LTA1LTAxVDEwOjAwOjAwLjAwMFoiLCJpZCI6InV1aWQifQ==',
    description:
      'Opaque base64-encoded cursor from a previous page response. ' +
      'Encodes `{createdAt: ISO8601, id: UUID}`. Pass `next_cursor` from the ' +
      'previous response. Malformed cursors → 400.',
  })
  @IsOptional()
  @IsString()
  cursor?: string;
}
