import { FixedClockAdapter } from '@/shared-kernel/infrastructure/adapters/fixed-clock.adapter';
import { HealthService } from './health.service';

describe('HealthService', () => {
  const dataSource = {
    query: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
  };
  const redis = {
    ping: jest.fn().mockResolvedValue('PONG'),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns ok status with version, uptime and clock-derived timestamp', () => {
    const fixedDate = new Date('2026-04-28T11:48:00.000Z');
    const clock = new FixedClockAdapter(fixedDate);
    const service = new HealthService(
      clock,
      dataSource as never,
      redis as never,
    );

    const result = service.getStatus();

    expect(result.status).toBe('ok');
    expect(result.timestamp).toBe(fixedDate.toISOString());
    expect(typeof result.version).toBe('string');
    expect(result.uptime_seconds).toBeGreaterThanOrEqual(0);
  });

  it('returns readiness checks for db and redis', async () => {
    const clock = new FixedClockAdapter(new Date('2026-04-28T11:48:00.000Z'));
    const service = new HealthService(
      clock,
      dataSource as never,
      redis as never,
    );

    await expect(service.getReadiness()).resolves.toEqual({
      status: 'ok',
      checks: { db: 'up', redis: 'up' },
    });
  });
});
