import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  DAY_OF_WEEK_VALUES,
  DayOfWeekValue,
} from '@/shared-kernel/domain/value-objects/day-of-week.vo';

export class ScheduleTemplateSlotResponseDto {
  @ApiProperty({ example: 'b1a2c3d4-0000-0000-0000-000000000001' })
  id!: string;

  @ApiProperty({ enum: DAY_OF_WEEK_VALUES, example: 'mon' })
  dayOfWeek!: DayOfWeekValue;

  @ApiProperty({ example: '09:00:00' })
  startTime!: string;

  @ApiProperty({ example: '09:45:00' })
  endTime!: string;

  @ApiProperty({ example: 'Утренний круг' })
  activityName!: string;

  @ApiPropertyOptional({
    example: 'b2a1c0d9-0000-0000-0000-000000000001',
    nullable: true,
  })
  locationId!: string | null;

  @ApiPropertyOptional({ example: 'Сбор в круг', nullable: true })
  description!: string | null;
}

export class ScheduleTemplateResponseDto {
  @ApiProperty({ example: 'a1b2c3d4-0000-0000-0000-000000000001' })
  id!: string;

  @ApiProperty({ example: 'f1a2b3c4-0000-0000-0000-000000000001' })
  kindergartenId!: string;

  @ApiPropertyOptional({
    example: 'a1b2c3d4-0000-0000-0000-000000000010',
    nullable: true,
    description: 'null = kindergarten-wide template',
  })
  groupId!: string | null;

  @ApiProperty({ example: 'Standard Mon-Fri' })
  name!: string;

  @ApiProperty({ example: 'weekly' })
  recurrence!: string;

  @ApiProperty({ example: true })
  isActive!: boolean;

  @ApiProperty({ example: '2026-05-04' })
  validFrom!: string;

  @ApiPropertyOptional({ example: '2026-09-01', nullable: true })
  validUntil!: string | null;

  @ApiProperty({ example: '2026-04-30T10:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ type: [ScheduleTemplateSlotResponseDto] })
  slots!: ScheduleTemplateSlotResponseDto[];
}
