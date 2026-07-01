import type { Job, Queue } from 'bullmq';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import {
  KASPI_PAYMENT_STATUS_JOB,
  KASPI_POLL_AGGRESSIVE_INTERVAL_MS,
  KASPI_POLL_AGGRESSIVE_WINDOW_MS,
  KASPI_POLL_BACKOFF_INTERVAL_MS,
  KASPI_POLL_BACKOFF_WINDOW_MS,
  KASPI_POLL_TAIL_INTERVAL_MS,
  KaspiPaymentStatusJobData,
} from './kaspi-payment-status.constants';
import {
  KaspiPaymentStatusProcessor,
  nextDelayMs,
} from './kaspi-payment-status.processor';
import type {
  KaspiPollResult,
  KaspiPaymentStatusPollerService,
} from './kaspi-payment-status-poller.service';

describe('nextDelayMs', () => {
  const created = new Date('2026-06-04T12:00:00.000Z');
  const at = (ageMs: number): Date => new Date(created.getTime() + ageMs);

  it('returns the aggressive interval for a fresh payment', () => {
    expect(nextDelayMs(created, at(0))).toBe(KASPI_POLL_AGGRESSIVE_INTERVAL_MS);
    expect(nextDelayMs(created, at(60_000))).toBe(
      KASPI_POLL_AGGRESSIVE_INTERVAL_MS,
    );
  });

  it('returns the backoff interval at the aggressive-window boundary', () => {
    expect(nextDelayMs(created, at(KASPI_POLL_AGGRESSIVE_WINDOW_MS))).toBe(
      KASPI_POLL_BACKOFF_INTERVAL_MS,
    );
    expect(nextDelayMs(created, at(KASPI_POLL_AGGRESSIVE_WINDOW_MS + 1))).toBe(
      KASPI_POLL_BACKOFF_INTERVAL_MS,
    );
  });

  it('returns the tail interval at the backoff-window boundary', () => {
    expect(nextDelayMs(created, at(KASPI_POLL_BACKOFF_WINDOW_MS))).toBe(
      KASPI_POLL_TAIL_INTERVAL_MS,
    );
    expect(
      nextDelayMs(created, at(KASPI_POLL_BACKOFF_WINDOW_MS + 60_000)),
    ).toBe(KASPI_POLL_TAIL_INTERVAL_MS);
  });

  it('defaults to 5s / 20s / 60s', () => {
    expect(KASPI_POLL_AGGRESSIVE_INTERVAL_MS).toBe(5_000);
    expect(KASPI_POLL_BACKOFF_INTERVAL_MS).toBe(20_000);
    expect(KASPI_POLL_TAIL_INTERVAL_MS).toBe(60_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// #1 + #2 — re-enqueue jobId construction. The poll chain self-reschedules by
// adding a new delayed job on a `reschedule` outcome. Two historical bugs:
//   #1: jobId used `:` (`kaspi-poll:<id>`) which BullMQ v5 rejects → first job
//       never enqueued.
//   #2: a FIXED jobId (`kaspi-poll-<id>`) collided with the still-active
//       current job → BullMQ deduped the reschedule → the chain died after one
//       tick. Fix: a monotonic `tick` suffix makes every reschedule unique.
// ─────────────────────────────────────────────────────────────────────────

const KG = 'kg-1111-2222';
const PAYMENT = 'pmt-aaaa-bbbb';
const POLL_NOW = new Date('2026-06-20T10:00:00.000Z');

class FixedClock extends ClockPort {
  constructor(private d: Date) {
    super();
  }
  now(): Date {
    return this.d;
  }
}

class FakePoller {
  result: KaspiPollResult = {
    outcome: 'reschedule',
    paymentCreatedAt: POLL_NOW,
    expireDate: null,
  };
  calls: Array<{ kg: string; id: string }> = [];
  pollOnce(kg: string, id: string): Promise<KaspiPollResult> {
    this.calls.push({ kg, id });
    return Promise.resolve(this.result);
  }
}

class FakeQueue {
  addCalls: Array<{
    name: string;
    data: unknown;
    opts: Record<string, unknown>;
  }> = [];
  add(
    name: string,
    data: unknown,
    opts: Record<string, unknown>,
  ): Promise<unknown> {
    this.addCalls.push({ name, data, opts });
    return Promise.resolve({});
  }
}

function buildProcessor(): {
  proc: KaspiPaymentStatusProcessor;
  poller: FakePoller;
  queue: FakeQueue;
} {
  const poller = new FakePoller();
  const queue = new FakeQueue();
  const proc = new KaspiPaymentStatusProcessor(
    poller as unknown as KaspiPaymentStatusPollerService,
    queue as unknown as Queue,
    new FixedClock(POLL_NOW),
  );
  return { proc, poller, queue };
}

function jobFor(tick?: number): Job<KaspiPaymentStatusJobData> {
  return {
    name: KASPI_PAYMENT_STATUS_JOB,
    data: {
      kindergartenId: KG,
      paymentId: PAYMENT,
      ...(tick != null ? { tick } : {}),
    },
  } as unknown as Job<KaspiPaymentStatusJobData>;
}

describe('KaspiPaymentStatusProcessor.process — reschedule jobId (#1/#2)', () => {
  it('re-enqueues with a per-tick jobId free of `:` (regression #1)', async () => {
    const { proc, queue } = buildProcessor();
    await proc.process(jobFor(0));

    expect(queue.addCalls).toHaveLength(1);
    const jobId = queue.addCalls[0].opts.jobId as string;
    expect(jobId).toBe(`kaspi-poll-${PAYMENT}-1`);
    expect(jobId).not.toContain(':');
  });

  it('increments the monotonic tick so each reschedule is a fresh, never-deduped job (regression #2)', async () => {
    const { proc, queue } = buildProcessor();
    await proc.process(jobFor(5));

    expect(queue.addCalls).toHaveLength(1);
    const { data, opts } = queue.addCalls[0];
    expect((data as KaspiPaymentStatusJobData).tick).toBe(6);
    expect(opts.jobId).toBe(`kaspi-poll-${PAYMENT}-6`);
  });

  it('treats a missing tick as 0 → next tick 1', async () => {
    const { proc, queue } = buildProcessor();
    await proc.process(jobFor(undefined));

    expect((queue.addCalls[0].data as KaspiPaymentStatusJobData).tick).toBe(1);
    expect(queue.addCalls[0].opts.jobId).toBe(`kaspi-poll-${PAYMENT}-1`);
  });

  it('carries the adaptive delay onto the re-enqueued job', async () => {
    const { proc, queue } = buildProcessor();
    await proc.process(jobFor(0));
    // paymentCreatedAt == now → aggressive window → 5s.
    expect(queue.addCalls[0].opts.delay).toBe(
      KASPI_POLL_AGGRESSIVE_INTERVAL_MS,
    );
  });

  for (const outcome of ['settled', 'failed', 'stop'] as const) {
    it(`does NOT re-enqueue on a ${outcome} outcome (chain terminates)`, async () => {
      const { proc, poller, queue } = buildProcessor();
      poller.result = {
        outcome,
        paymentCreatedAt: POLL_NOW,
        expireDate: null,
      };
      const summary = await proc.process(jobFor(0));

      expect(queue.addCalls).toHaveLength(0);
      expect(summary.outcome).toBe(outcome);
      expect(summary.nextDelayMs).toBeNull();
    });
  }

  it('ignores an unknown job name without polling or enqueuing', async () => {
    const { proc, poller, queue } = buildProcessor();
    const summary = await proc.process({
      name: 'some-other-job',
      data: { kindergartenId: KG, paymentId: PAYMENT },
    } as unknown as Job<KaspiPaymentStatusJobData>);

    expect(summary.outcome).toBe('ignored');
    expect(poller.calls).toHaveLength(0);
    expect(queue.addCalls).toHaveLength(0);
  });
});
