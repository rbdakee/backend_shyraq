import { FixedClockAdapter } from '@/shared-kernel/infrastructure/adapters/fixed-clock.adapter';
import { KASPI_VERSION_HEALTH_REDIS_KEY } from '@/modules/billing/kaspi-version-health.constants';
import { HealthService } from './health.service';

describe('HealthService', () => {
  const dbPing = {
    ping: jest.fn().mockResolvedValue(undefined),
  };
  const redis = {
    ping: jest.fn().mockResolvedValue('PONG'),
    // Default: no cached Kaspi snapshot → checks.kaspi === 'unknown'.
    get: jest.fn().mockResolvedValue(null),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    redis.ping.mockResolvedValue('PONG');
    redis.get.mockResolvedValue(null);
  });

  it('returns ok status with version, uptime and clock-derived timestamp', () => {
    const fixedDate = new Date('2026-04-28T11:48:00.000Z');
    const clock = new FixedClockAdapter(fixedDate);
    const service = new HealthService(clock, dbPing as never, redis as never);

    const result = service.getStatus();

    expect(result.status).toBe('ok');
    expect(result.timestamp).toBe(fixedDate.toISOString());
    expect(typeof result.version).toBe('string');
    expect(result.uptime_seconds).toBeGreaterThanOrEqual(0);
  });

  it('returns readiness checks for db and redis with kaspi unknown when no snapshot', async () => {
    const clock = new FixedClockAdapter(new Date('2026-04-28T11:48:00.000Z'));
    const service = new HealthService(clock, dbPing as never, redis as never);

    await expect(service.getReadiness()).resolves.toEqual({
      status: 'ok',
      checks: { db: 'up', redis: 'up', kaspi: 'unknown' },
    });
  });

  it('reports db down when ping throws and redis up when ping returns PONG', async () => {
    const clock = new FixedClockAdapter(new Date('2026-04-28T11:48:00.000Z'));
    const badPing = {
      ping: jest.fn().mockRejectedValue(new Error('connection_refused')),
    };
    const service = new HealthService(clock, badPing as never, redis as never);

    await expect(service.getReadiness()).resolves.toEqual({
      status: 'degraded',
      checks: { db: 'down', redis: 'up', kaspi: 'unknown' },
    });
  });

  it('reports kaspi up and detail when cached snapshot is accepted, without affecting status', async () => {
    const clock = new FixedClockAdapter(new Date('2026-04-28T11:48:00.000Z'));
    redis.get.mockResolvedValue(
      JSON.stringify({
        build: '1071',
        accepted: true,
        alarm: null,
        checkedAt: '2026-06-04T10:00:00.000Z',
      }),
    );
    const service = new HealthService(clock, dbPing as never, redis as never);

    const result = await service.getReadiness();

    expect(redis.get).toHaveBeenCalledWith(KASPI_VERSION_HEALTH_REDIS_KEY);
    expect(result.status).toBe('ok');
    expect(result.checks).toEqual({ db: 'up', redis: 'up', kaspi: 'up' });
    expect(result.kaspi_detail).toEqual({
      build: '1071',
      checked_at: '2026-06-04T10:00:00.000Z',
    });
  });

  it('reports kaspi down when build blocked but keeps status ok while db+redis up', async () => {
    const clock = new FixedClockAdapter(new Date('2026-04-28T11:48:00.000Z'));
    redis.get.mockResolvedValue(
      JSON.stringify({
        build: '1000',
        accepted: false,
        alarm: 'OldVersionToUpdate',
        checkedAt: '2026-06-04T10:00:00.000Z',
      }),
    );
    const service = new HealthService(clock, dbPing as never, redis as never);

    const result = await service.getReadiness();

    expect(result.status).toBe('ok');
    expect(result.checks).toEqual({ db: 'up', redis: 'up', kaspi: 'down' });
  });

  it('reports kaspi unknown when snapshot is unparseable', async () => {
    const clock = new FixedClockAdapter(new Date('2026-04-28T11:48:00.000Z'));
    redis.get.mockResolvedValue('{not-json');
    const service = new HealthService(clock, dbPing as never, redis as never);

    const result = await service.getReadiness();

    expect(result.checks.kaspi).toBe('unknown');
    expect(result.kaspi_detail).toBeUndefined();
  });
});
