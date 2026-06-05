import { FixedClockAdapter } from '@/shared-kernel/infrastructure/adapters/fixed-clock.adapter';
import { KASPI_VERSION_HEALTH_REDIS_KEY } from './kaspi-version-health.constants';
import { KaspiVersionHealthService } from './kaspi-version-health.service';
import type { KaspiVersionProbeResult } from './kaspi-version-probe.service';

describe('KaspiVersionHealthService', () => {
  const checkedAt = new Date('2026-06-04T10:00:00.000Z');

  const makeProbe = (impl: () => KaspiVersionProbeResult | never) => ({
    probe: jest.fn(() => Promise.resolve().then(impl)),
  });

  const makeRedis = () => ({
    set: jest.fn().mockResolvedValue('OK'),
  });

  const originalCronEnv = process.env.KASPI_VERSION_HEALTH_CRON;

  afterEach(() => {
    if (originalCronEnv === undefined) {
      delete process.env.KASPI_VERSION_HEALTH_CRON;
    } else {
      process.env.KASPI_VERSION_HEALTH_CRON = originalCronEnv;
    }
    jest.clearAllMocks();
  });

  it('writes an accepted snapshot to Redis with a TTL when enabled', async () => {
    process.env.KASPI_VERSION_HEALTH_CRON = 'enabled';
    const probe = makeProbe(() => ({ build: '1071', accepted: true }));
    const redis = makeRedis();
    const clock = new FixedClockAdapter(checkedAt);
    const service = new KaspiVersionHealthService(
      probe as never,
      redis as never,
      clock,
    );

    await service.runProbe();

    expect(probe.probe).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledTimes(1);
    const [key, payload, ex, ttl] = redis.set.mock.calls[0];
    expect(key).toBe(KASPI_VERSION_HEALTH_REDIS_KEY);
    expect(ex).toBe('EX');
    expect(typeof ttl).toBe('number');
    expect(ttl).toBeGreaterThan(0);
    expect(JSON.parse(payload as string)).toEqual({
      build: '1071',
      accepted: true,
      alarm: null,
      checkedAt: checkedAt.toISOString(),
    });
  });

  it('writes a blocked snapshot with accepted false and alarm set', async () => {
    process.env.KASPI_VERSION_HEALTH_CRON = 'enabled';
    const probe = makeProbe(() => ({
      build: '1000',
      accepted: false,
      alarm: 'OldVersionToUpdate' as const,
    }));
    const redis = makeRedis();
    const service = new KaspiVersionHealthService(
      probe as never,
      redis as never,
      new FixedClockAdapter(checkedAt),
    );

    await service.runProbe();

    expect(redis.set).toHaveBeenCalledTimes(1);
    const payload = redis.set.mock.calls[0][1] as string;
    expect(JSON.parse(payload)).toEqual({
      build: '1000',
      accepted: false,
      alarm: 'OldVersionToUpdate',
      checkedAt: checkedAt.toISOString(),
    });
  });

  it('does not write to Redis and does not throw when the probe throws', async () => {
    process.env.KASPI_VERSION_HEALTH_CRON = 'enabled';
    const probe = makeProbe(() => {
      throw new Error('kaspi_unreachable');
    });
    const redis = makeRedis();
    const service = new KaspiVersionHealthService(
      probe as never,
      redis as never,
      new FixedClockAdapter(checkedAt),
    );

    await expect(service.runProbe()).resolves.toBeUndefined();
    expect(probe.probe).toHaveBeenCalledTimes(1);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('does not probe or write when the cron is not enabled', async () => {
    delete process.env.KASPI_VERSION_HEALTH_CRON;
    const probe = makeProbe(() => ({ build: '1071', accepted: true }));
    const redis = makeRedis();
    const service = new KaspiVersionHealthService(
      probe as never,
      redis as never,
      new FixedClockAdapter(checkedAt),
    );

    await service.runProbe();

    expect(probe.probe).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });
});
