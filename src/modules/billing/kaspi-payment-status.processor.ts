import { Inject, Logger } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import {
  KASPI_PAYMENT_STATUS_JOB,
  KASPI_PAYMENT_STATUS_QUEUE,
  KASPI_POLL_AGGRESSIVE_INTERVAL_MS,
  KASPI_POLL_AGGRESSIVE_WINDOW_MS,
  KASPI_POLL_BACKOFF_INTERVAL_MS,
  KASPI_POLL_BACKOFF_WINDOW_MS,
  KASPI_POLL_TAIL_INTERVAL_MS,
  KaspiPaymentStatusJobData,
} from './kaspi-payment-status.constants';
import { KaspiPaymentStatusPollerService } from './kaspi-payment-status-poller.service';

export interface KaspiPaymentStatusSummary {
  paymentId: string;
  outcome: string;
  /** Delay (ms) of the re-enqueued next tick, or null when the chain stops. */
  nextDelayMs: number | null;
}

/**
 * KaspiPaymentStatusProcessor — drives ONE poll tick then either re-enqueues
 * the next delayed tick (adaptive cadence by payment age) or stops the chain.
 *
 * Thin: all settlement / refresh / notify logic lives in
 * `KaspiPaymentStatusPollerService.pollOnce`. The processor only owns the
 * BullMQ scheduling (next-delay computation + re-enqueue).
 */
@Processor(KASPI_PAYMENT_STATUS_QUEUE)
export class KaspiPaymentStatusProcessor extends WorkerHost {
  private readonly logger = new Logger(KaspiPaymentStatusProcessor.name);

  constructor(
    private readonly poller: KaspiPaymentStatusPollerService,
    @InjectQueue(KASPI_PAYMENT_STATUS_QUEUE)
    private readonly queue: Queue,
    // Explicit @Inject(ClockPort): BullMQ workers boot under a different DI
    // graph and can otherwise see `undefined` for abstract-class tokens
    // (mirrors MonthlyBillingProcessor's SP1 finding).
    @Inject(ClockPort) private readonly clock: ClockPort,
  ) {
    super();
  }

  async process(
    job: Job<KaspiPaymentStatusJobData>,
  ): Promise<KaspiPaymentStatusSummary> {
    if (job.name !== KASPI_PAYMENT_STATUS_JOB) {
      // Future jobs on the same queue may exist; ignore unknown names.
      return { paymentId: '', outcome: 'ignored', nextDelayMs: null };
    }

    const { kindergartenId, paymentId } = job.data;
    this.logger.log(
      `kaspi-poll tick start: kg=${kindergartenId} payment=${paymentId}`,
    );

    const result = await this.poller.pollOnce(kindergartenId, paymentId);

    let nextDelay: number | null = null;
    if (result.outcome === 'reschedule') {
      const createdAt = result.paymentCreatedAt ?? this.clock.now();
      nextDelay = nextDelayMs(createdAt, this.clock.now());
      await this.queue.add(KASPI_PAYMENT_STATUS_JOB, job.data, {
        // Deterministic jobId keeps the poll chain single-lived: BullMQ dedups
        // a re-add of an already-queued tick. This completed delayed job's id
        // is re-addable, which is exactly the reschedule semantics.
        jobId: `kaspi-poll:${paymentId}`,
        attempts: 1,
        delay: nextDelay,
        removeOnComplete: { count: 50 },
        removeOnFail: { count: 50 },
      });
    }
    // settled | failed | stop → do nothing, the chain terminates here.

    this.logger.log(
      `kaspi-poll tick done: kg=${kindergartenId} payment=${paymentId} outcome=${result.outcome} nextDelayMs=${nextDelay ?? 'none'}`,
    );
    return { paymentId, outcome: result.outcome, nextDelayMs: nextDelay };
  }
}

/**
 * Adaptive next-tick delay by payment age (see the cadence table in
 * `kaspi-payment-status-poller.service.ts`):
 *   age < AGGRESSIVE_WINDOW → AGGRESSIVE_INTERVAL (5s)
 *   age < BACKOFF_WINDOW    → BACKOFF_INTERVAL    (20s)
 *   else                    → TAIL_INTERVAL       (60s)
 */
export function nextDelayMs(createdAt: Date, now: Date): number {
  const age = now.getTime() - createdAt.getTime();
  if (age < KASPI_POLL_AGGRESSIVE_WINDOW_MS) {
    return KASPI_POLL_AGGRESSIVE_INTERVAL_MS;
  }
  if (age < KASPI_POLL_BACKOFF_WINDOW_MS) {
    return KASPI_POLL_BACKOFF_INTERVAL_MS;
  }
  return KASPI_POLL_TAIL_INTERVAL_MS;
}
