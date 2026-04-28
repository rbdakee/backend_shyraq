import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class ArchiveChildDto {
  @ApiPropertyOptional({
    example: 'Family relocated.',
    description: 'Optional human-readable reason persisted on the row.',
  })
  @IsOptional()
  @IsString()
  reason?: string;
}
