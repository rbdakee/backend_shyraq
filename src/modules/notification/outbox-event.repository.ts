import { EntityManager } from 'typeorm';
import { OutboxEvent } from './domain/entities/outbox-event.entity';

export interface EnqueueOutboxEventInput {
  kindergartenId: string;
  eventKey: string;
  payload: Record<string, unknown>;
}

/**
 * Port over `notification_outbox`.
 *
 * Lifecycle methods (`claimBatch`, `markDispatched`, `markFailedWithRetry`)
 * are dispatcher-side: they MUST run inside an explicit transaction so the
 * `FOR UPDATE SKIP LOCKED` lock taken by `claimBatch` is released only when
 * the dispatcher commits/rolls back. The dispatcher (T4) is responsible for
 * setting `SET LOCAL app.bypass_rls = 'true'` on that transaction so the
 * worker can see rows from every tenant — the repository deliberately does
 * NOT touch GUCs.
 *
 * `enqueue` is producer-side and accepts an optional `manager` so the
 * caller's business transaction can include the outbox row atomically with
 * the event that triggered it (avoids the post-commit microtask race
 * documented in B8 NotificationPort TODO).
 */
export abstract class OutboxEventRepository {
  /**
   * Persist a new outbox row. When `manager` is supplied the insert
   * participates in that transaction; otherwise the relational
   * implementation falls back to the tenant-scoped manager from
   * `tenantStorage`, then to its own connection-level manager.
   */
  abstract enqueue(
    input: EnqueueOutboxEventInput,
    manager?: EntityManager,
  ): Promise<OutboxEvent>;

  /**
   * Atomically lock and return up to `limit` pending rows whose
   * `next_retry_at <= now`. Uses `FOR UPDATE SKIP LOCKED` so concurrent
   * pollers do not double-claim. The lock is held for the lifetime of the
   * caller-supplied transaction; the dispatcher must call `markDispatched`
   * or `markFailedWithRetry` within the same TX before commit.
   */
  abstract claimBatch(
    manager: EntityManager,
    limit: number,
    now: Date,
  ): Promise<OutboxEvent[]>;

  /**
   * Terminal success transition: status='dispatched', dispatched_at=$now.
   * Must run in the same TX as the prior `claimBatch`.
   */
  abstract markDispatched(
    manager: EntityManager,
    id: string,
    now: Date,
  ): Promise<void>;

  /**
   * Failure transition. When `terminal=false`, the row goes back to
   * `pending` with the next retry scheduled at `nextRetryAt`. When
   * `terminal=true`, the row goes to `failed` and is excluded from the
   * polling partial index.
   *
   * The repository does not compute attempts/backoff itself — it stores the
   * values the dispatcher computed via the domain `markFailed` method. That
   * keeps the policy (max attempts, backoff curve) in the domain layer.
   */
  abstract markFailedWithRetry(
    manager: EntityManager,
    id: string,
    now: Date,
    reason: string,
    attempts: number,
    nextRetryAt: Date,
    terminal: boolean,
  ): Promise<void>;

  /**
   * Convenience read for tests / future admin endpoints. Subject to the
   * caller's RLS scope — the dispatcher uses the bypass GUC, while admin
   * lookups stay tenant-scoped.
   */
  abstract findById(id: string): Promise<OutboxEvent | null>;
}
