import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import {
  CHILD_INTRADAY_STATUS_VALUES,
  ChildIntradayStatusValue,
} from '../domain/value-objects/child-intraday-status.vo';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class SetDailyStatusDto {
  @ApiProperty({ example: 'cccccccc-cccc-cccc-cccc-cccccccccccc' })
  @IsUUID()
  childId!: string;

  @ApiProperty({
    example: '2026-05-01',
    description: 'ISO date YYYY-MM-DD (no timezone).',
  })
  @IsISO8601({ strict: true })
  @Matches(ISO_DATE_RE, { message: 'date must be YYYY-MM-DD' })
  date!: string;

  @ApiProperty({
    enum: CHILD_INTRADAY_STATUS_VALUES,
    example: 'sick',
  })
  @IsEnum(CHILD_INTRADAY_STATUS_VALUES)
  status!: ChildIntradayStatusValue;

  @ApiPropertyOptional({
    example: 'Сообщение от родителя в WhatsApp',
    description: 'Optional note (≤2000 chars).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}
