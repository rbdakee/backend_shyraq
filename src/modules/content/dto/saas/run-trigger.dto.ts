import { ApiProperty } from '@nestjs/swagger';
import { IsISO8601, IsOptional } from 'class-validator';

/**
 * Shared body for the three B17 manual processor triggers.
 * Both fields are optional — all three endpoints work with an empty body.
 */
export class RunTriggerDto {
  @ApiProperty({
    example: '2026-05-07T07:00:00.000Z',
    description:
      'Optional anchor timestamp for the run (ISO-8601). Useful for back-filling or testing specific dates. Defaults to now.',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsISO8601()
  now?: string | null;
}
