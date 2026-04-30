import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsUUID } from 'class-validator';

export class ListWeekSnapshotsQuery {
  @ApiPropertyOptional({ example: 'a1b2c3d4-0000-0000-0000-000000000001' })
  @IsOptional()
  @IsUUID()
  groupId?: string;

  @ApiPropertyOptional({ example: '2026-05-01' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ example: '2026-09-01' })
  @IsOptional()
  @IsDateString()
  to?: string;
}
