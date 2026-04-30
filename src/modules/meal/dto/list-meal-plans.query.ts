import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsUUID } from 'class-validator';

export class ListMealPlansQuery {
  @ApiProperty({
    example: '2026-05-01',
    description: 'Start date (inclusive, YYYY-MM-DD)',
  })
  @IsDateString()
  date_from: string;

  @ApiProperty({
    example: '2026-05-07',
    description: 'End date (inclusive, YYYY-MM-DD)',
  })
  @IsDateString()
  date_to: string;

  @ApiPropertyOptional({
    example: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
    description: 'Filter by group UUID (omit for all)',
  })
  @IsOptional()
  @IsUUID()
  group_id?: string;
}

export class ListMealPlansByDateQuery {
  @ApiPropertyOptional({
    example: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
    description: 'Filter by group UUID',
  })
  @IsOptional()
  @IsUUID()
  group_id?: string;

  @ApiPropertyOptional({
    example: '2026-05-01',
    description: 'Exact date filter (YYYY-MM-DD)',
  })
  @IsOptional()
  @IsDateString()
  date?: string;
}

export class ParentMenuQuery {
  @ApiPropertyOptional({
    example: '2026-04-28',
    description:
      'Start of week (Monday, YYYY-MM-DD). Defaults to current Monday.',
  })
  @IsOptional()
  @IsDateString()
  week_start?: string;
}
