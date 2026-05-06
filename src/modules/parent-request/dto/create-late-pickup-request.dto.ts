import { ApiProperty } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Body shape for `POST /parent/requests/late-pickup`. Parent will be late on
 * a specific date and asks the kindergarten to keep the child past closing.
 *
 * `expected_time` is HH:MM (24-hour, leading zeros). The accept hook in B13
 * may issue a tariff invoice — for now `invoice_id` stays null and a TODO
 * marker lives in the service.
 */
export class CreateLatePickupRequestDto {
  @ApiProperty({ example: 'cccccccc-cccc-cccc-cccc-cccccccccccc' })
  @IsUUID()
  child_id!: string;

  @ApiProperty({ example: '2026-05-15' })
  @IsString()
  @Matches(DATE_REGEX, { message: 'date must match YYYY-MM-DD' })
  date!: string;

  @ApiProperty({
    example: '19:30',
    description: '24-hour time HH:MM with leading zeros.',
  })
  @IsString()
  @Matches(TIME_REGEX, {
    message: 'expected_time must match HH:MM (24-hour, leading zeros)',
  })
  expected_time!: string;

  @ApiProperty({
    example: 'Задержусь на работе — заберу к 19:30.',
    nullable: true,
    required: false,
    maxLength: 2000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string | null;
}
