/**
 * B22a T10 — AdminLifecycleService unit spec.
 *
 * Drives the service via an in-memory FakeQueue that mimics the BullMQ
 * `Queue` API surface used by AdminLifecycleService:
 *   - `getFailed(start, end)` — returns the configured failed jobs slice.
 *   - `getJob(id)` — returns the matching FakeJob (or undefined).
 *
 * Asserts:
 *   1. listFailedJobs filters by `payload.kindergartenId` for per-kg admins.
 *   2. listFailedJobs returns ALL jobs when scope.kgId is undefined (super-admin).
 *   3. listFailedJobs paginates with offset-based cursor.
 *   4. retryFailedJob calls job.retry() and returns enqueued shape.
 *   5. retryFailedJob throws LifecycleJobNotFoundError when job missing.
 *   6. retryFailedJob throws LifecycleJobNotInFailedStateError when job
 *      is not in failed state.
 *   7. retryFailedJob throws LifecycleJobCrossTenantForbiddenError when
 *      per-kg admin retries job from a different kg.
 */
import type { Queue } from 'bullmq';
import { AdminLifecycleService } from './admin-lifecycle.service';
import { LifecycleJobCrossTenantForbiddenError } from './domain/errors/lifecycle-job-cross-tenant-forbidden.error';
import { LifecycleJobNotFoundError } from './domain/errors/lifecycle-job-not-found.error';
import { LifecycleJobNotInFailedStateError } from './domain/errors/lifecycle-job-not-in-failed-state.error';

const KG_A = 'a1111111-1111-1111-1111-111111111111';
const KG_B = 'b2222222-2222-2222-2222-222222222222';

interface FakeJob {
  id: string;
  name: string;
  data: Record<string, unknown>;
  failedReason: string | null;
  attemptsMade: number;
  timestamp: number;
  finishedOn: number | null;
  failed: boolean;
  retryCalls: number;
  isFailed(): Promise<boolean>;
  retry(): Promise<void>;
}

function makeFakeJob(overrides: Partial<FakeJob> & { id: string }): FakeJob {
  const job: FakeJob = {
    name: 'lifecycle:pro-rata-refund',
    data: { kindergartenId: KG_A },
    failedReason: 'boom',
    attemptsMade: 3,
    timestamp: Date.now() - 1000,
    finishedOn: Date.now(),
    failed: true,
    retryCalls: 0,
    isFailed(): Promise<boolean> {
      return Promise.resolve(this.failed);
    },
    retry(): Promise<void> {
      this.retryCalls++;
      this.failed = false;
      return Promise.resolve();
    },
    ...overrides,
  };
  return job;
}

class FakeQueue {
  jobs: FakeJob[] = [];

  getFailed(start: number, end: number): Promise<FakeJob[]> {
    // BullMQ's getFailed only returns jobs currently in the failed set.
    const failedOnly = this.jobs.filter((j) => j.failed);
    // BullMQ getFailed(start, end) is INCLUSIVE on end.
    return Promise.resolve(failedOnly.slice(start, end + 1));
  }

  getJob(id: string): Promise<FakeJob | undefined> {
    return Promise.resolve(this.jobs.find((j) => j.id === id));
  }
}

function build(): { service: AdminLifecycleService; queue: FakeQueue } {
  const queue = new FakeQueue();
  const service = new AdminLifecycleService(queue as unknown as Queue);
  return { service, queue };
}

describe('AdminLifecycleService', () => {
  describe('listFailedJobs', () => {
    it('returns only jobs whose payload.kindergartenId matches scope.kgId', async () => {
      const { service, queue } = build();
      queue.jobs = [
        makeFakeJob({ id: '1', data: { kindergartenId: KG_A } }),
        makeFakeJob({ id: '2', data: { kindergartenId: KG_B } }),
        makeFakeJob({ id: '3', data: { kindergartenId: KG_A } }),
      ];

      const out = await service.listFailedJobs({ kgId: KG_A }, 50, undefined);
      expect(out.items).toHaveLength(2);
      expect(out.items.map((i) => i.id)).toEqual(['1', '3']);
      expect(out.nextCursor).toBeNull();
    });

    it('returns all jobs when scope.kgId is undefined (super-admin view)', async () => {
      const { service, queue } = build();
      queue.jobs = [
        makeFakeJob({ id: '1', data: { kindergartenId: KG_A } }),
        makeFakeJob({ id: '2', data: { kindergartenId: KG_B } }),
      ];

      const out = await service.listFailedJobs({}, 50, undefined);
      expect(out.items).toHaveLength(2);
    });

    it('emits next_cursor when the BullMQ window fills the requested limit', async () => {
      const { service, queue } = build();
      queue.jobs = [
        makeFakeJob({ id: '1' }),
        makeFakeJob({ id: '2' }),
        makeFakeJob({ id: '3' }),
      ];

      const page1 = await service.listFailedJobs({ kgId: KG_A }, 2, undefined);
      expect(page1.items).toHaveLength(2);
      expect(page1.items.map((i) => i.id)).toEqual(['1', '2']);
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await service.listFailedJobs(
        { kgId: KG_A },
        2,
        page1.nextCursor!,
      );
      expect(page2.items).toHaveLength(1);
      expect(page2.items[0].id).toBe('3');
      expect(page2.nextCursor).toBeNull();
    });

    it('clamps the limit to 1..200', async () => {
      const { service, queue } = build();
      queue.jobs = [makeFakeJob({ id: '1' })];

      // Out-of-range values fall back to the bounds.
      await service.listFailedJobs({ kgId: KG_A }, 0, undefined);
      await service.listFailedJobs({ kgId: KG_A }, 9999, undefined);
      // No throws.
    });

    it('maps job fields to the wire view shape', async () => {
      const { service, queue } = build();
      queue.jobs = [
        makeFakeJob({
          id: '1',
          name: 'lifecycle:pro-rata-refund',
          data: { kindergartenId: KG_A, childId: 'c1' },
          failedReason: 'because',
          attemptsMade: 3,
          timestamp: 100,
          finishedOn: 200,
        }),
      ];

      const out = await service.listFailedJobs({ kgId: KG_A }, 50, undefined);
      expect(out.items[0]).toEqual({
        id: '1',
        name: 'lifecycle:pro-rata-refund',
        payload: { kindergartenId: KG_A, childId: 'c1' },
        failedReason: 'because',
        attemptsMade: 3,
        timestamp: 100,
        finishedOn: 200,
      });
    });

    it('decodes a malformed cursor as offset=0 (no throw)', async () => {
      const { service, queue } = build();
      queue.jobs = [makeFakeJob({ id: '1' })];

      const out = await service.listFailedJobs(
        { kgId: KG_A },
        50,
        'not-base64-or-json',
      );
      expect(out.items).toHaveLength(1);
    });
  });

  describe('retryFailedJob', () => {
    it('retries a failed job and returns enqueued shape', async () => {
      const { service, queue } = build();
      const job = makeFakeJob({ id: '1', data: { kindergartenId: KG_A } });
      queue.jobs = [job];

      const out = await service.retryFailedJob({ kgId: KG_A }, '1');
      expect(out).toEqual({ enqueued: true, job_id: '1' });
      expect(job.retryCalls).toBe(1);
    });

    it('throws LifecycleJobNotFoundError when the job does not exist', async () => {
      const { service } = build();
      await expect(
        service.retryFailedJob({ kgId: KG_A }, 'missing'),
      ).rejects.toBeInstanceOf(LifecycleJobNotFoundError);
    });

    it('throws LifecycleJobNotInFailedStateError when job is not failed', async () => {
      const { service, queue } = build();
      queue.jobs = [
        makeFakeJob({ id: '1', failed: false, data: { kindergartenId: KG_A } }),
      ];

      await expect(
        service.retryFailedJob({ kgId: KG_A }, '1'),
      ).rejects.toBeInstanceOf(LifecycleJobNotInFailedStateError);
    });

    it('throws LifecycleJobCrossTenantForbiddenError when per-kg admin retries a job from another kg', async () => {
      const { service, queue } = build();
      queue.jobs = [makeFakeJob({ id: '1', data: { kindergartenId: KG_B } })];

      await expect(
        service.retryFailedJob({ kgId: KG_A }, '1'),
      ).rejects.toBeInstanceOf(LifecycleJobCrossTenantForbiddenError);
    });

    it('allows cross-kg retry when scope.kgId is undefined (super-admin)', async () => {
      const { service, queue } = build();
      const job = makeFakeJob({ id: '1', data: { kindergartenId: KG_B } });
      queue.jobs = [job];

      const out = await service.retryFailedJob({}, '1');
      expect(out.enqueued).toBe(true);
      expect(job.retryCalls).toBe(1);
    });
  });
});
