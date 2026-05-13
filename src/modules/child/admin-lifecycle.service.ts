import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Job, Queue } from 'bullmq';
import { LifecycleJobCrossTenantForbiddenError } from './domain/errors/lifecycle-job-cross-tenant-forbidden.error';
import { LifecycleJobNotFoundError } from './domain/errors/lifecycle-job-not-found.error';
import { LifecycleJobNotInFailedStateError } from './domain/errors/lifecycle-job-not-in-failed-state.error';
import { LIFECYCLE_QUEUE } from './lifecycle-queue.constants';

/**
 * Operator-facing view of a single failed BullMQ `lifecycle` queue job.
 * Wire shape (snake_case) is owned by the DTO layer; the service hands
 * back camelCase so the controller can present it unambiguously.
 */
export interface LifecycleFailedJobView {
  id: string;
  name: string;
  payload: Record<string, unknown>;
  failedReason: string | null;
  attemptsMade: number;
  /** ms epoch — when the job was originally created. */
  timestamp: number;
  /** ms epoch — when the job moved to its terminal state (failed). */
  finishedOn: number | null;
}

export interface ListFailedJobsResult {
  items: LifecycleFailedJobView[];
  /** Opaque base64 cursor; null when the page exhausts the queue. */
  nextCursor: string | null;
}

/**
 * Cap on the slice fetched from BullMQ per request. Keeps Redis round-trips
 * bounded even when the operator hammers `?limit=200`. Any caller request
 * above this is truncated by the DTO validation (`@Max(200)`).
 */
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

interface CursorState {
  offset: number;
}

/**
 * Encode the next-page cursor as base64-encoded JSON. The shape is
 * intentionally trivial (just `{offset}`) — BullMQ's `getFailed(start, end)`
 * is offset-based and the operator surface does not need stronger
 * guarantees than "skip the rows we just returned".
 */
function encodeCursor(state: CursorState): string {
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64');
}

function decodeCursor(cursor: string | undefined): CursorState {
  if (!cursor) return { offset: 0 };
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded) as Partial<CursorState>;
    const offset = Number.isFinite(parsed.offset) ? Number(parsed.offset) : 0;
    return { offset: Math.max(0, Math.floor(offset)) };
  } catch {
    return { offset: 0 };
  }
}

/**
 * AdminLifecycleService — admin operator surface over the BullMQ
 * `lifecycle` queue (B22a T10 closes B21 T7-L2).
 *
 * Why it lives in `child` module:
 *   The `lifecycle` queue and its `ProRataRefundProcessor` are owned by
 *   B21 (`ChildService.archive` is the producer, `BillingModule` hosts
 *   the processor). Putting the admin DLQ surface here keeps the
 *   producer-side module wiring (`BullModule.registerQueue` is already in
 *   `ChildModule`) and avoids a new top-level module just for two
 *   endpoints.
 *
 * Tenant scoping:
 *   BullMQ has no native per-tenant filter — every job in the queue
 *   carries `payload.kindergartenId` (set by the producer). For per-kg
 *   admins, we filter the post-fetch list and reject cross-kg retries
 *   with 403. Super-admin support (omitted scope) sees everything; the
 *   controller decides which mode to invoke.
 */
@Injectable()
export class AdminLifecycleService {
  private readonly logger = new Logger(AdminLifecycleService.name);

  constructor(
    @InjectQueue(LIFECYCLE_QUEUE)
    private readonly queue: Queue,
  ) {}

  /**
   * List failed jobs with offset-based cursor pagination.
   *
   * @param scope.kgId  When set, only jobs whose `payload.kindergartenId`
   *                    matches are returned (per-kg admin view). When
   *                    undefined, all failed jobs are returned (super-admin).
   * @param limit       1..200, defaults to 50.
   * @param cursor      Opaque base64 cursor returned from a prior call.
   *
   * Note: per-kg filtering is applied AFTER the BullMQ fetch (post-filter)
   * because BullMQ stores jobs by ZSET-score and has no `WHERE
   * payload.kindergartenId = ?` capability. For tenants with many failed
   * jobs the operator may need to page through several windows before the
   * filtered slice fills the requested limit. We do NOT loop internally —
   * a single window per call keeps the response time bounded; the
   * frontend follows the cursor until items shrink.
   */
  async listFailedJobs(
    scope: { kgId?: string },
    limit: number | undefined,
    cursor: string | undefined,
  ): Promise<ListFailedJobsResult> {
    const effectiveLimit = Math.max(
      1,
      Math.min(MAX_LIMIT, limit ?? DEFAULT_LIMIT),
    );
    const { offset } = decodeCursor(cursor);
    const start = offset;
    // BullMQ getFailed(start, end) is INCLUSIVE on both ends, so requesting
    // `effectiveLimit` items requires `end = start + limit - 1`.
    const end = start + effectiveLimit - 1;

    const rawJobs = (await this.queue.getFailed(start, end)) as Job[];
    const items: LifecycleFailedJobView[] = [];
    for (const job of rawJobs) {
      const data = (job.data ?? {}) as Record<string, unknown>;
      if (scope.kgId !== undefined && data['kindergartenId'] !== scope.kgId) {
        continue;
      }
      items.push({
        id: String(job.id ?? ''),
        name: job.name,
        payload: data,
        failedReason: job.failedReason ?? null,
        attemptsMade: job.attemptsMade ?? 0,
        timestamp: job.timestamp ?? 0,
        finishedOn: job.finishedOn ?? null,
      });
    }

    // If the BullMQ window returned fewer rows than requested, we've
    // exhausted the queue regardless of post-filter dropouts. Otherwise
    // the operator may want to page on — emit a cursor pointing at the
    // next window. We always advance `offset` by `effectiveLimit` (the
    // raw window size), not by `items.length`, so post-filter drops do
    // not shorten the next window.
    const nextCursor =
      rawJobs.length < effectiveLimit
        ? null
        : encodeCursor({ offset: start + effectiveLimit });

    return { items, nextCursor };
  }

  /**
   * Re-enqueue a failed job. Only failed jobs can be retried; jobs in
   * `wait`/`active`/`completed` are rejected with 409.
   *
   * @param scope.kgId  When set, the job's `payload.kindergartenId` must
   *                    match — otherwise 403. When undefined (super-admin),
   *                    cross-kg retries are allowed.
   * @param jobId       BullMQ job id (string).
   *
   * Returns `{ enqueued: true, job_id }` on success — wire shape for the
   * controller. Internally calls `job.retry()` which moves the job back
   * to `wait` (or `delayed` if a backoff is configured).
   */
  async retryFailedJob(
    scope: { kgId?: string },
    jobId: string,
  ): Promise<{ enqueued: true; job_id: string }> {
    const job = (await this.queue.getJob(jobId)) as Job | undefined | null;
    if (!job) {
      throw new LifecycleJobNotFoundError(jobId);
    }

    if (scope.kgId !== undefined) {
      const data = (job.data ?? {}) as Record<string, unknown>;
      if (data['kindergartenId'] !== scope.kgId) {
        throw new LifecycleJobCrossTenantForbiddenError(jobId);
      }
    }

    const isFailed = await job.isFailed();
    if (!isFailed) {
      throw new LifecycleJobNotInFailedStateError(jobId);
    }

    await job.retry();

    this.logger.log(
      `lifecycle DLQ retry: jobId=${jobId} name=${job.name} kg=${(job.data as Record<string, unknown>)?.['kindergartenId'] ?? 'n/a'}`,
    );

    return { enqueued: true, job_id: jobId };
  }
}
