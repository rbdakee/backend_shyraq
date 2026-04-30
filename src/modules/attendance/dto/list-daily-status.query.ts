import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ListDailyStatusQuery {
  @ApiPropertyOptional({
    example: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    description: 'Filter by child id.',
  })
  @IsOptional()
  @IsUUID()
  childId?: string;

  @ApiPropertyOptional({
    example: '2026-05-01',
    description: 'Inclusive lower bound date (YYYY-MM-DD).',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be YYYY-MM-DD' })
  from?: string;

  @ApiPropertyOptional({
    example: '2026-05-31',
    description: 'Inclusive upper bound date (YYYY-MM-DD).',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must be YYYY-MM-DD' })
  to?: string;

  @ApiPropertyOptional({ example: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
