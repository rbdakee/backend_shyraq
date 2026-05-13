import { Inject, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { DataSource, EntityManager } from 'typeorm';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { tenantStorage } from '@/database/tenant-storage';
import {
  defaultBackoff,
  OutboxEvent,
} from './domain/entities/outbox-event.entity';
import {
  NotificationDispatcher,
  SavepointRollback,
} from './notification-dispatcher.service';
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
 *   1. Open ONE outer TypeORM transaction. This holds the row-level locks
 *      from `claimBatch` until commit; it must NOT be aborted by a single
 *      bad event, otherwise `markDispatched` calls earlier in the loop
 *      would be lost and the rows re-claimed on the next tick (duplicate
 *      delivery).
 *   2. `SET LOCAL app.bypass_rls = 'true'` so the worker sees rows from
 *      every tenant — the table is RLS-policied and the runtime app role is
 *      NOBYPASSRLS, so without this GUC the SELECT would return zero rows.
 *   3. `claimBatch(...)` → up to `OUTBOX_BATCH_SIZE` rows locked with
 *      `FOR UPDATE SKIP LOCKED`. Two pollers running in parallel can claim
 *      disjoint subsets safely.
 *   4. For each claimed event, open a NESTED transaction (TypeORM emits a
 *      SAVEPOINT inside the outer TX). The dispatch + the corresponding
 *      `markDispatched` / `markFailedWithRetry` happen together in that
 *      savepoint. If the savepoint throws (e.g. a DB error inside the
 *      dispatcher poisons it with `current transaction is aborted, …`),
 *      PostgreSQL `ROLLBACK TO SAVEPOINT` undoes only the failing event's
 *      side-effects; the outer TX stays alive and earlier successful
 *      `markDispatched`s remain durable.
 *   5. After savepoint rollback, mark the failing row as `failed` via the
 *      OUTER manager. That UPDATE runs cleanly because the outer TX was
 *      not poisoned.
 *   6. Outer TX commits at end of loop. The locked rows release.
 *
 * Without the savepoint barrier, a single dispatcher DB error would abort
 * the outer TX, every prior `markDispatched` would roll back, and those
 * rows would be re-claimed on the next 2s tick — turning at-least-once
 * delivery into "occasionally many-times".
 *
 * RLS isolation: all repositories called inside `dispatcher.dispatch(event)`
 * must participate in the savepoint that already has `app.bypass_rls`
 * inherited from the outer TX. We propagate the savepoint manager via
 * `tenantStorage.run()` so that the `manager()` helper in every relational
 * repository resolves to the savepoint manager rather than pulling a fresh
 * pool connection that has no GUC set.
 */
@Processor(OUTBOX_POLLER_QUEUE)
export class OutboxPollerProcessor extends WorkerHost {
  private readonly logger = new Logger(OutboxPollerProcessor.name);

  constructor(
    private readonly outboxRepo: OutboxEventRepository,
    private readonly dispatcher: NotificationDispatcher,
    private readonly dataSource: DataSource,
    // SP1 (FINDINGS): explicit `@Inject(ClockPort)` so the worker process
    // resolves the abstract port via reflect-metadata (BullMQ workers boot
    // under a different DI graph and can otherwise see `undefined` for
    // abstract-class tokens).
    @Inject(ClockPort) private readonly clock: ClockPort,
  ) {
    super();
  }

  async process(_job: Job): Promise<void> {
    const now = this.clock.now();
    await this.dataSource.transaction(async (outerManager) => {
      // Worker bypasses RLS so the directory scan crosses every tenant.
      // GUC is inherited by nested savepoints opened on the same connection.
      await outerManager.query(`SET LOCAL app.bypass_rls = 'true'`);

      const events = await this.outboxRepo.claimBatch(
        outerManager,
        OUTBOX_BATCH_SIZE,
        now,
      );
      if (events.length === 0) return;

      // Events are dispatched SEQUENTIALLY — intentional ordering guarantee.
      //
      // Why not Promise.allSettled (parallel):
      //   Some event-key sequences for the same child carry logical ordering
      //   (e.g. `guardian.approved` must be visible before
      //   `guardian.permissions_updated`). Parallelising within a batch
      //   would race those writes and break at-least-once ordering. The
      //   2-second tick + SKIP LOCKED allow multiple *workers* to run
      //   disjoint batches in parallel — that is the intended concurrency
      //   primitive, not in-batch parallelism. Keep this loop sequential.
      for (const event of events) {
        await this.processOne(outerManager, event, now);
      }
    });
  }

  /**
   * Process one event inside its own savepoint. On savepoint failure, mark
   * the row failed via the outer manager so we never silently drop a row
   * (which would be re-claimed forever) and never poison the outer TX.
   *
   * In-memory state: `event.markFailed(...)` mutates `attempts` and
   * `_status`. We snapshot the pre-savepoint state so that, if the
   * savepoint throws AFTER `markFailed` was already applied, we can re-
   * hydrate from the snapshot and call `markFailed` exactly once for the
   * outer-manager UPDATE — never double-incrementing the attempts counter.
   */
  private async processOne(
    outerManager: EntityManager,
    event: OutboxEvent,
    now: Date,
  ): Promise<void> {
    const snapshot = event.toState();
    try {
      await outerManager.transaction(async (savepoint) => {
        // Publish the savepoint manager via AsyncLocalStorage so every
        // repository called by the dispatcher (e.g. notificationRepo,
        // pushTokenRepo, preferenceRepo, guardianRepo) picks up the
        // savepoint manager. If the dispatcher hits a DB error, the
        // savepoint rolls back and the outer TX stays alive.
        await tenantStorage.run(
          { kgId: null, bypass: true, entityManager: savepoint },
          async () => {
            const result = await this.dispatcher.dispatch(event);
            if (result.status === 'dispatched') {
              await this.outboxRepo.markDispatched(savepoint, event.id!, now);
              return;
            }
            // result.status === 'failed' — throw to roll the savepoint
            // back. Side-effects performed inside the savepoint (history
            // row inserts) revert atomically, so the next retry will not
            // duplicate them. The outer-catch below applies markFailed
            // exactly once via the OUTER manager (using `result.reason`
            // as the failure message via SavepointRollback).
            throw new SavepointRollback(result.reason);
          },
        );
      });
    } catch (err) {
      // Savepoint already rolled back; outer TX is alive. The DB row is
      // back to its pre-savepoint state, so we restart from the snapshot
      // and apply `markFailed` exactly once before persisting via the
      // outer manager.
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `outbox_savepoint_failed event=${event.eventKey} id=${event.id ?? '<unknown>'}: ${reason}`,
      );
      const fresh = OutboxEvent.hydrate(snapshot);
      try {
        fresh.markFailed(now, reason, defaultBackoff);
      } catch {
        // Snapshot indicated the row was already terminal — nothing to
        // mark, the loop continues. Should not happen in practice because
        // claimBatch only returns pending rows.
        return;
      }
      try {
        await this.outboxRepo.markFailedWithRetry(
          outerManager,
          fresh.id!,
          now,
          fresh.failedReason ?? reason,
          fresh.attempts,
          fresh.nextRetryAt,
          fresh.isTerminal(),
        );
      } catch (markErr) {
        // If even the outer-manager UPDATE fails, log and let the outer
        // TX commit anyway — the row stays pending and will be re-claimed
        // next tick. Re-throwing here would roll back ALL prior
        // markDispatched calls in the batch (the bug we just fixed).
        this.logger.error(
          `outbox_mark_failed_in_outer_tx event=${event.eventKey} id=${event.id ?? '<unknown>'}: ${(markErr as Error).message}`,
        );
      }
    }
  }
}
