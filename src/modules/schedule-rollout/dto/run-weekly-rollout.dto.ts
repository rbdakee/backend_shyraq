import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional } from 'class-validator';

/**
 * Optional override for the weekly rollout's source week (Monday). If omitted,
 * the service computes the previous-Monday in Asia/Almaty automatically. Must
 * be an ISO date string `YYYY-MM-DD`.
 */
export class RunWeeklyRolloutDto {
  @ApiPropertyOptional({
    example: '2026-04-27',
    description:
      'ISO date YYYY-MM-DD — Monday of the source week. Optional; defaults to the previous Monday in Asia/Almaty.',
  })
  @IsOptional()
  @IsDateString()
  fromMonday?: string;
}
