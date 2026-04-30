import { ApiProperty } from '@nestjs/swagger';
import { IsDateString } from 'class-validator';

export class CopyWeekDto {
  @ApiProperty({
    example: '2026-04-27',
    description:
      'ISO date YYYY-MM-DD — must be Monday (start of source week). copyWeekToNext projects from this week onto the following Monday.',
  })
  @IsDateString()
  fromMonday!: string;
}
