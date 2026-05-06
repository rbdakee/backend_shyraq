import { ApiProperty } from '@nestjs/swagger';
import {
  DAY_OF_WEEK_VALUES,
  DayOfWeekValue,
} from '@/shared-kernel/domain/value-objects/day-of-week.vo';
import { ActivityEventResponseDto } from './activity-event.response.dto';

export class ScheduleWeekDayDto {
  @ApiProperty({ enum: DAY_OF_WEEK_VALUES, example: 'mon' })
  dayOfWeek!: DayOfWeekValue;

  @ApiProperty({ example: '2026-05-04' })
  date!: string;

  @ApiProperty({ type: [ActivityEventResponseDto] })
  events!: ActivityEventResponseDto[];
}

export class ScheduleWeekResponseDto {
  @ApiProperty({ example: '2026-05-04' })
  weekStart!: string;

  @ApiProperty({ type: [ScheduleWeekDayDto] })
  days!: ScheduleWeekDayDto[];
}
