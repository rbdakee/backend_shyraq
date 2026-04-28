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
    example: { db: 'up', redis: 'up' },
    properties: {
      db: { type: 'string', enum: ['up', 'down'] },
      redis: { type: 'string', enum: ['up', 'down'] },
    },
  })
  checks!: {
    db: 'up' | 'down';
    redis: 'up' | 'down';
  };
}
