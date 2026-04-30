import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsIn, IsOptional, IsUUID } from 'class-validator';
import {
  ACTIVITY_EVENT_STATUS_VALUES,
  ActivityEventStatusValue,
} from '../domain/value-objects/activity-event-status.vo';

export class ListActivityEventsQuery {
  @ApiPropertyOptional({ example: 'a1b2c3d4-0000-0000-0000-000000000001' })
  @IsOptional()
  @IsUUID()
  groupId?: string;

  @ApiPropertyOptional({
    example: '2026-05-04',
    description:
      'Inclusive lower bound on starts_at. ISO date or ISO datetime.',
  })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({
    example: '2026-05-09',
    description:
      'Exclusive upper bound on starts_at. ISO date or ISO datetime.',
  })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ enum: ACTIVITY_EVENT_STATUS_VALUES })
  @IsOptional()
  @IsIn(ACTIVITY_EVENT_STATUS_VALUES)
  status?: ActivityEventStatusValue;
}
