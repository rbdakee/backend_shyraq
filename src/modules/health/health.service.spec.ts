import { FixedClockAdapter } from '@/shared-kernel/infrastructure/adapters/fixed-clock.adapter';
import { HealthService } from './health.service';

describe('HealthService', () => {
  it('returns ok status with version, uptime and clock-derived timestamp', () => {
    const fixedDate = new Date('2026-04-28T11:48:00.000Z');
    const clock = new FixedClockAdapter(fixedDate);
    const service = new HealthService(clock);

    const result = service.getStatus();

    expect(result.status).toBe('ok');
    expect(result.timestamp).toBe(fixedDate.toISOString());
    expect(typeof result.version).toBe('string');
    expect(result.uptime_seconds).toBeGreaterThanOrEqual(0);
  });
});
