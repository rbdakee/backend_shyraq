import { ApiProperty } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Body shape for `POST /parent/requests/vacation`. Parent takes the child OUT
 * of the садик for the inclusive `[date_from..date_to]` range.
 *
 * Server-side validation:
 *   - date_from <= date_to
 *   - date_from >= today (Asia/Almaty)
 */
export class CreateVacationRequestDto {
  @ApiProperty({ example: 'cccccccc-cccc-cccc-cccc-cccccccccccc' })
  @IsUUID()
  child_id!: string;

  @ApiProperty({ example: '2026-06-01' })
  @IsString()
  @Matches(DATE_REGEX, { message: 'date_from must match YYYY-MM-DD' })
  date_from!: string;

  @ApiProperty({ example: '2026-06-14' })
  @IsString()
  @Matches(DATE_REGEX, { message: 'date_to must match YYYY-MM-DD' })
  date_to!: string;

  @ApiProperty({
    example: 'Едем к бабушке на 2 недели.',
    nullable: true,
    required: false,
    maxLength: 2000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string | null;
}
