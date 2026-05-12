import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Body for POST /admin/children/:id/archive.
 * `archive_reason` is required: 1–500 characters after trim.
 */
export class ArchiveChildDto {
  @ApiProperty({
    description: 'Human-readable reason for archiving (1–500 characters).',
    example: 'Family relocated to another city',
    minLength: 1,
    maxLength: 500,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  archive_reason!: string;
}
