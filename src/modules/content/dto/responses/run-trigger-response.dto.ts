import { ApiProperty } from '@nestjs/swagger';

export class RunTriggerResponseDto {
  @ApiProperty({
    example: '2026-05-07T07:00:00.000Z',
    description: 'Timestamp at which the trigger ran.',
  })
  triggered_at!: string;

  @ApiProperty({
    example: 3,
    description: 'Number of records processed/created/published/deleted.',
  })
  processed_count!: number;

  @ApiProperty({
    example: 1,
    description: 'Number of records skipped (idempotency, no-op).',
  })
  skipped_count!: number;

  @ApiProperty({
    example: 5,
    description: 'Number of kindergartens visited (cross-tenant run).',
    required: false,
  })
  kindergartens_processed?: number;
}
