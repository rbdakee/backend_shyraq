import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import {
  SLOT_CATEGORY_VALUES,
  SlotCategoryValue,
} from '../domain/value-objects/slot-category.vo';
import { DAY_OF_WEEK_VALUES } from '@/shared-kernel/domain/value-objects/day-of-week.vo';

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;

export class UpdateSlotDto {
  @ApiPropertyOptional({ enum: DAY_OF_WEEK_VALUES, example: 'tue' })
  @IsOptional()
  @IsIn(DAY_OF_WEEK_VALUES)
  dayOfWeek?: (typeof DAY_OF_WEEK_VALUES)[number];

  @ApiPropertyOptional({ example: '10:00' })
  @IsOptional()
  @IsString()
  @Matches(TIME_PATTERN)
  startTime?: string;

  @ApiPropertyOptional({ example: '11:00' })
  @IsOptional()
  @IsString()
  @Matches(TIME_PATTERN)
  endTime?: string;

  @ApiPropertyOptional({ example: 'ИЗО' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  activityName?: string;

  @ApiPropertyOptional({ enum: SLOT_CATEGORY_VALUES, example: 'meal' })
  @IsOptional()
  @IsIn(SLOT_CATEGORY_VALUES)
  category?: SlotCategoryValue;

  @ApiPropertyOptional({
    example: 'b2a1c0d9-0000-0000-0000-000000000001',
    nullable: true,
  })
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional({ example: 'Уточнённое описание', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;
}
