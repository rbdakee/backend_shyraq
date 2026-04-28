import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export class ListChildrenQueryDto {
  @ApiPropertyOptional({ enum: ['card_created', 'active', 'archived'] })
  @IsOptional()
  @IsIn(['card_created', 'active', 'archived'])
  status?: 'card_created' | 'active' | 'archived';

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  current_group_id?: string;

  @ApiPropertyOptional({ description: 'Substring search on full_name / iin.' })
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(0)
  offset?: number;
}
