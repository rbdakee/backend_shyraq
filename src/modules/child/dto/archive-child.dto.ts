import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Body for POST /admin/children/:id/archive.
 *
 * `archive_reason` is required: 1–500 characters AFTER trim. The
 * @Transform step trims surrounding whitespace before class-validator
 * sees the value so whitespace-only payloads (`"   "`) fail the
 * @MinLength(1) check with a 400/422 instead of slipping through to the
 * service layer (T6/T7 M2: previously DTO accepted whitespace and the
 * service surfaced a different `archive_reason_required` error code,
 * making the validation contract misleading to API clients).
 */
export class ArchiveChildDto {
  @ApiProperty({
    description: 'Human-readable reason for archiving (1–500 characters).',
    example: 'Family relocated to another city',
    minLength: 1,
    maxLength: 500,
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  archive_reason!: string;
}
