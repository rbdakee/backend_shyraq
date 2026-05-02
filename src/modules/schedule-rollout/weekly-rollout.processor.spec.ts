/**
 * WeeklyRolloutProcessor — service-unit suite.
 *
 * Covers the BullMQ replacement for the previous `@nestjs/schedule`
 * `@Cron`-driven `WeeklyRolloutCron`. Verifies:
 *   - The processor delegates to `WeeklyRolloutService.runWeeklyRollout`
 *     with the previous-Monday derived from the injected clock and
 *     `source='cron'`.
 *   - Top-level service failures PROPAGATE to BullMQ so the scheduler's
 *     `attempts` + exponential `backoff` policy can retry within the
 *     same Sunday window. Per-kg failures are isolated INSIDE the
 *     service; only true orchestration-level errors reach the processor
 *     boundary, and those must surface so BullMQ retries them.
 *   - The processor ignores BullMQ jobs whose name does not match
 *     `WEEKLY_ROLLOUT_JOB`, which lets the queue host other jobs in the
 *     future without colliding.
 */
import { Job } from 'bullmq';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import {
  RolloutSummary,
  RunWeeklyRolloutInput,
  WeeklyRolloutService,
} from './weekly-rollout.service';
import {
  WEEKLY_ROLLOUT_CRON_EXPRESSION,
  WEEKLY_ROLLOUT_CRON_TIMEZONE,
  WEEKLY_ROLLOUT_JOB,
  WEEKLY_ROLLOUT_QUEUE,
  WeeklyRolloutProcessor,
} from './weekly-rollout.processor';

class FixedClock extends ClockPort {
  constructor(private readonly t: Date) {
    super();
  }
  now(): Date {
    return this.t;
  }
}

class FakeRolloutService {
  calls: RunWeeklyRolloutInput[] = [];
  shouldThrow = false;

  computePreviousMonday(now: Date): Date {
    // Mirrors the real impl — pure JS, Almaty-shifted ISO Monday.
    const ALMATY_OFFSET_MIN = 5 * 60;
    const DAY_MS = 24 * 60 * 60 * 1000;
    const almaty = new Date(now.getTime() + ALMATY_OFFSET_MIN * 60 * 1000);
    const isoDay = ((almaty.getUTCDay() + 6) % 7) + 1;
    const almatyMidnight = Date.UTC(
      almaty.getUTCFullYear(),
      almaty.getUTCMonth(),
      almaty.getUTCDate(),
      0,
      0,
      0,
      0,
    );
    const currentMonday = almatyMidnight - (isoDay - 1) * DAY_MS;
    return new Date(currentMonday);
  }

  runWeeklyRollout(input: RunWeeklyRolloutInput): Promise<RolloutSummary> {
    this.calls.push(input);
    if (this.shouldThrow) return Promise.reject(new Error('boom'));
    return Promise.resolve({
      fromMonday: input.fromMonday.toISOString().slice(0, 10),
      source: input.source,
      kindergartens: [],
      totals: {
        kindergartens: 0,
        copiedGroups: 0,
        skippedGroups: 0,
        totalEvents: 0,
        plansCreated: 0,
        plansSkipped: 0,
        errors: 0,
      },
    });
  }
}

function makeJob(name: string): Job {
  return { name } as unknown as Job;
}

describe('WeeklyRolloutProcessor — constants', () => {
  it('exposes queue + job name + cron expression / timezone for the scheduler to upsert', () => {
    expect(WEEKLY_ROLLOUT_QUEUE).toBe('schedule-rollout');
    expect(WEEKLY_ROLLOUT_JOB).toBe('weekly-rollout');
    expect(WEEKLY_ROLLOUT_CRON_EXPRESSION).toBe('0 23 * * 0');
    expect(WEEKLY_ROLLOUT_CRON_TIMEZONE).toBe('Asia/Almaty');
  });
});

describe('WeeklyRolloutProcessor.process', () => {
  it('derives previous-Monday from the clock and delegates to the service with source=cron', async () => {
    const fakeService = new FakeRolloutService();
    const clock = new FixedClock(new Date('2026-05-03T18:00:00.000Z')); // Sun 23:00 Almaty
    const proc = new WeeklyRolloutProcessor(
      fakeService as unknown as WeeklyRolloutService,
      clock,
    );

    await proc.process(makeJob(WEEKLY_ROLLOUT_JOB));

    expect(fakeService.calls).toHaveLength(1);
    expect(fakeService.calls[0].source).toBe('cron');
    expect(fakeService.calls[0].fromMonday.toISOString().slice(0, 10)).toBe(
      '2026-04-27',
    );
  });

  it('rethrows a top-level service failure so BullMQ can retry the tick (attempts+backoff)', async () => {
    const fakeService = new FakeRolloutService();
    fakeService.shouldThrow = true;
    const clock = new FixedClock(new Date('2026-05-03T18:00:00.000Z'));
    const proc = new WeeklyRolloutProcessor(
      fakeService as unknown as WeeklyRolloutService,
      clock,
    );
    await expect(proc.process(makeJob(WEEKLY_ROLLOUT_JOB))).rejects.toThrow(
      'boom',
    );
  });

  it('ignores jobs whose name is not the weekly-rollout name (forward compat)', async () => {
    const fakeService = new FakeRolloutService();
    const clock = new FixedClock(new Date('2026-05-03T18:00:00.000Z'));
    const proc = new WeeklyRolloutProcessor(
      fakeService as unknown as WeeklyRolloutService,
      clock,
    );

    await proc.process(makeJob('some-other-job'));

    expect(fakeService.calls).toEqual([]);
  });
});
