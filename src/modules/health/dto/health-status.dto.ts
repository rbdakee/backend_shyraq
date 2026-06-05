import { ApiProperty } from '@nestjs/swagger';

export class HealthStatusDto {
  @ApiProperty({ example: 'ok', enum: ['ok', 'degraded'] })
  status!: 'ok' | 'degraded';

  @ApiProperty({ example: '0.0.1' })
  version!: string;

  @ApiProperty({ example: 12.345, description: 'Process uptime in seconds' })
  uptime_seconds!: number;

  @ApiProperty({ example: '2026-04-28T11:48:00.000Z' })
  timestamp!: string;
}

export class HealthReadyDto {
  @ApiProperty({ example: 'ok', enum: ['ok', 'degraded'] })
  status!: 'ok' | 'degraded';

  @ApiProperty({
    example: { db: 'up', redis: 'up', kaspi: 'up' },
    properties: {
      db: { type: 'string', enum: ['up', 'down'] },
      redis: { type: 'string', enum: ['up', 'down'] },
      // K9 — Kaspi version-gate health. INFORMATIONAL only: does NOT affect
      // the top-level `status`. `up` = build accepted, `down` =
      // `OldVersionToUpdate` blocked, `unknown` = not yet probed / stale.
      kaspi: { type: 'string', enum: ['up', 'down', 'unknown'] },
    },
  })
  checks!: {
    db: 'up' | 'down';
    redis: 'up' | 'down';
    kaspi: 'up' | 'down' | 'unknown';
  };

  @ApiProperty({
    required: false,
    description:
      'K9 — last cached Kaspi version-gate snapshot (present once the cron has run).',
    example: { build: '1071', checked_at: '2026-06-04T10:00:00.000Z' },
  })
  kaspi_detail?: {
    build: string;
    checked_at: string;
  };
}
