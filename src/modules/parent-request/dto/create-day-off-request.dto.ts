import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Body shape for `POST /parent/requests/day-off`. Parent asks the kindergarten
 * to keep the child IN the садик on a weekend (Saturday or Sunday).
 *
 * `weekend_dates` semantics:
 *   - 1 or 2 entries
 *   - each ISO-formatted (YYYY-MM-DD)
 *   - each must fall on Sat or Sun (validated server-side)
 *   - if 2 entries — both must be in the same calendar week (validated
 *     server-side)
 *   - none in the past (validated server-side via ClockPort)
 */
export class CreateDayOffRequestDto {
  @ApiProperty({ example: 'cccccccc-cccc-cccc-cccc-cccccccccccc' })
  @IsUUID()
  child_id!: string;

  @ApiProperty({
    example: ['2026-05-09', '2026-05-10'],
    description:
      '1 or 2 weekend dates (Sat or Sun). Both dates must fall in the same calendar week when 2 are passed.',
    isArray: true,
    type: 'string',
    minItems: 1,
    maxItems: 2,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2)
  @IsString({ each: true })
  @Matches(DATE_REGEX, {
    each: true,
    message: 'each weekend_dates entry must match YYYY-MM-DD',
  })
  weekend_dates!: string[];

  @ApiProperty({
    example: 'Бабушка приедет в субботу — оставим ребёнка.',
    nullable: true,
    required: false,
    maxLength: 2000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string | null;
}
