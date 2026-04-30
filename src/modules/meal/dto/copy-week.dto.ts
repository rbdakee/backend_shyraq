import { ApiProperty } from '@nestjs/swagger';
import { IsDateString } from 'class-validator';

export class CopyWeekDto {
  @ApiProperty({
    example: '2026-04-28',
    description: 'Monday of the source week (YYYY-MM-DD)',
  })
  @IsDateString()
  source_week_start_date: string;
}
