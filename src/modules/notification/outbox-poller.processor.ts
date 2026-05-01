import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { DataSource } from 'typeorm';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { defaultBackoff } from './domain/entities/outbox-event.entity';
import { NotificationDispatcher } from './notification-dispatcher.service';
import { OutboxEventRepository } from './outbox-event.repository';

/**
 * BullMQ queue name for the outbox poller. The worker process registers a
 * repeatable job under this queue at boot; the api process never enqueues
 * onto it.
 */
export const OUTBOX_POLLER_QUEUE = 'notifications-outbox';

/**
 * Repeatable job name. Distinct from the queue name so future fan-out jobs
 * (e.g. dead-letter requeue) can share the queue without colliding.
 */
export const OUTBOX_POLLER_JOB = 'poll';

/**
 * Maximum number of pending rows pulled per poll cycle. Tuned for the
 * 2-second tick: 50 rows × ~30ms per dispatch ≈ 1.5s, leaving headroom for
 * the next tick. A poll that exceeds the tick is still safe — BullMQ
 * concurrency=1 (default) skips overlapping ticks.
 */
export const OUTBOX_BATCH_SIZE = 50;

/**
 * OutboxPollerProcessor — BullMQ worker that drains `notification_outbox`.
 *
 * Flow per tick:
 *   1. Open ONE TypeORM transaction.
 *   2. `SET LOCAL app.bypass_rls = 'true'` so the worker sees rows from
 *      every tenant — the table is RLS-policied and the runtime app role is
 *      NOBYPASSRLS, so without this GUC the SELECT would return zero rows.
 *   3. `claimBatch(...)` → up to `OUTBOX_BATCH_SIZE` rows locked with
 *      `FOR UPDATE SKIP LOCKED`. Two pollers running in parallel can claim
 *      disjoint subsets safely; the lock is released only at commit.
 *   4. For each claimed event:
 *        - `dispatcher.dispatch(event)` → returns `dispatched` or `failed`.
 *        - On success → `markDispatched(...)`.
 *        - On failure → domain `markFailed(now, reason, defaultBackoff)`
 *          updates `attempts` + `nextRetryAt`. If the entity reports
 *          terminal (`status === 'failed'`), pass `terminal=true` so the
 *          row leaves the polling partial index.
 *   5. Commit. The locked rows release. If the worker crashes mid-batch,
 *      the TX rolls back and rows return to the next poll's claim set.
 *
 * Defense-in-depth: the dispatcher MUST NOT throw (it returns `failed`).
 * Should it ever throw despite that contract, the catch below records it as
 * a failed attempt for the row currently in flight rather than abandoning
 * the rest of the batch. This is the only place in the worker where a
 * dispatcher exception is caught — anywhere upstream a throw will roll the
 * whole TX back.
 */
@Processor(OUTBOX_POLLER_QUEUE)
export class OutboxPollerProcessor extends WorkerHost {
  private readonly logger = new Logger(OutboxPollerProcessor.name);

  constructor(
    private readonly outboxRepo: OutboxEventRepository,
    private readonly dispatcher: NotificationDispatcher,
    private readonly dataSource: DataSource,
    private readonly clock: ClockPort,
  ) {
    super();
  }

  async process(_job: Job): Promise<void> {
    const now = this.clock.now();
    await this.dataSource.transaction(async (manager) => {
      // Worker bypasses RLS so the directory scan crosses every tenant.
      await manager.query(`SET LOCAL app.bypass_rls = 'true'`);

      const events = await this.outboxRepo.claimBatch(
        manager,
        OUTBOX_BATCH_SIZE,
        now,
      );
      if (events.length === 0) return;

      for (const event of events) {
        try {
          const result = await this.dispatcher.dispatch(event);
          if (result.status === 'dispatched') {
            await this.outboxRepo.markDispatched(manager, event.id!, now);
            continue;
          }
          // result.status === 'failed' — fall through to the failure branch.
          event.markFailed(now, result.reason, defaultBackoff);
          await this.outboxRepo.markFailedWithRetry(
            manager,
            event.id!,
            now,
            event.failedReason ?? result.reason,
            event.attempts,
            event.nextRetryAt,
            event.isTerminal(),
          );
        } catch (err) {
          // Dispatcher contract says "never throw"; this branch is
          // defense-in-depth so a regression in the dispatcher does not
          // poison the whole batch.
          const reason = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `outbox_dispatcher_threw event=${event.eventKey} id=${event.id ?? '<unknown>'}: ${reason}`,
          );
          event.markFailed(now, reason, defaultBackoff);
          await this.outboxRepo.markFailedWithRetry(
            manager,
            event.id!,
            now,
            event.failedReason ?? reason,
            event.attempts,
            event.nextRetryAt,
            event.isTerminal(),
          );
        }
      }
    });
  }
}
