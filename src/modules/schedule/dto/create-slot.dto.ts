import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { DAY_OF_WEEK_VALUES } from '@/shared-kernel/domain/value-objects/day-of-week.vo';

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;

export class CreateSlotDto {
  @ApiProperty({
    enum: DAY_OF_WEEK_VALUES,
    example: 'mon',
  })
  @IsIn(DAY_OF_WEEK_VALUES)
  dayOfWeek!: (typeof DAY_OF_WEEK_VALUES)[number];

  @ApiProperty({ example: '09:00', description: '24-hour HH:MM or HH:MM:SS' })
  @IsString()
  @Matches(TIME_PATTERN)
  startTime!: string;

  @ApiProperty({ example: '09:45', description: '24-hour HH:MM or HH:MM:SS' })
  @IsString()
  @Matches(TIME_PATTERN)
  endTime!: string;

  @ApiProperty({ example: 'Утренний круг' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  activityName!: string;

  @ApiPropertyOptional({ example: 'b2a1c0d9-0000-0000-0000-000000000001' })
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional({ example: 'Сбор в круг, обсуждение дня' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;
}
