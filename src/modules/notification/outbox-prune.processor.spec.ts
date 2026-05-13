/**
 * B22b T12 — OutboxPruneProcessor unit spec.
 *
 * Drives the processor with an in-memory outbox repo + a fake DataSource
 * that just invokes the transaction callback with a no-op
 * EntityManager. Asserts:
 *   1. `dispatched` rows older than `now - 7d` are deleted; rows newer
 *      than that are kept.
 *   2. `failed` rows older than `now - 30d` are deleted; rows in the
 *      8..29d range are kept (failed retention is wider than dispatched).
 *   3. `pending` rows are never pruned (only terminal rows).
 *   4. Idempotent re-run on the same `now` produces a zero-delete summary
 *      because the older rows are already gone.
 *   5. Manual job payload `now` overrides `clock.now()`.
 *
 * Self-contained: no DataSource transactions, no PG.
 */
import { DataSource, EntityManager } from 'typeorm';
import { Job } from 'bullmq';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { OutboxEvent } from './domain/entities/outbox-event.entity';
import { OutboxEventStatusValue } from './domain/value-objects/outbox-event-status.vo';
import {
  EnqueueOutboxEventInput,
  OutboxEventRepository,
} from './outbox-event.repository';
import {
  OutboxPruneProcessor,
  OUTBOX_PRUNE_DISPATCHED_RETENTION_MS,
  OUTBOX_PRUNE_FAILED_RETENTION_MS,
  OUTBOX_PRUNE_RECURRING_JOB,
  OUTBOX_PRUNE_MANUAL_JOB,
} from './outbox-prune.processor';

const NOW = new Date('2026-05-13T04:00:00.000Z');

class FixedClock extends ClockPort {
  constructor(private d: Date) {
    super();
  }
  now(): Date {
    return this.d;
  }
}

interface FakeRow {
  id: string;
  status: OutboxEventStatusValue;
  createdAt: Date;
}

class FakeOutboxRepo extends OutboxEventRepository {
  rows: FakeRow[] = [];

  enqueue(_input: EnqueueOutboxEventInput): Promise<OutboxEvent> {
    return Promise.reject(new Error('not used'));
  }
  claimBatch(): Promise<OutboxEvent[]> {
    return Promise.resolve([]);
  }
  markDispatched(): Promise<void> {
    return Promise.resolve();
  }
  markFailedWithRetry(): Promise<void> {
    return Promise.resolve();
  }
  findById(): Promise<OutboxEvent | null> {
    return Promise.resolve(null);
  }

  override prunePrunables(
    _manager: EntityManager,
    dispatchedCutoff: Date,
    failedCutoff: Date,
  ): Promise<{ deletedDispatched: number; deletedFailed: number }> {
    let deletedDispatched = 0;
    let deletedFailed = 0;
    this.rows = this.rows.filter((r) => {
      if (r.status === 'dispatched' && r.createdAt < dispatchedCutoff) {
        deletedDispatched += 1;
        return false;
      }
      if (r.status === 'failed' && r.createdAt < failedCutoff) {
        deletedFailed += 1;
        return false;
      }
      // pending rows always kept; in-window terminal rows kept.
      return true;
    });
    return Promise.resolve({ deletedDispatched, deletedFailed });
  }
}

function makeFakeDataSource(): DataSource {
  return {
    transaction: <T>(cb: (em: EntityManager) => Promise<T>): Promise<T> =>
      cb({
        query: () => Promise.resolve(undefined),
      } as unknown as EntityManager),
  } as unknown as DataSource;
}

function makeJob(name: string, data: object = {}): Job {
  return { name, data } as unknown as Job;
}

function ms(days: number): number {
  return days * 24 * 60 * 60 * 1000;
}

describe('OutboxPruneProcessor', () => {
  function build(now: Date = NOW): {
    proc: OutboxPruneProcessor;
    repo: FakeOutboxRepo;
  } {
    const repo = new FakeOutboxRepo();
    const clock = new FixedClock(now);
    const ds = makeFakeDataSource();
    const proc = new OutboxPruneProcessor(repo, ds, clock);
    return { proc, repo };
  }

  it('deletes dispatched rows older than 7 days; keeps newer dispatched rows', async () => {
    const { proc, repo } = build();
    repo.rows.push(
      {
        id: 'd-old',
        status: 'dispatched',
        createdAt: new Date(NOW.getTime() - ms(8)),
      },
      {
        id: 'd-edge',
        status: 'dispatched',
        // Exactly 7 days old — cutoff is `now - 7d`, so this row sits
        // on the boundary. The DELETE uses `created_at < cutoff` (strict
        // less-than) → boundary row is kept.
        createdAt: new Date(NOW.getTime() - ms(7)),
      },
      {
        id: 'd-fresh',
        status: 'dispatched',
        createdAt: new Date(NOW.getTime() - ms(1)),
      },
    );

    const result = await proc.process(makeJob(OUTBOX_PRUNE_RECURRING_JOB));

    expect(result.deletedDispatched).toBe(1);
    expect(result.deletedFailed).toBe(0);
    expect(repo.rows.map((r) => r.id).sort()).toEqual(['d-edge', 'd-fresh']);
  });

  it('deletes failed rows older than 30 days; keeps rows in the 8..29d range', async () => {
    const { proc, repo } = build();
    repo.rows.push(
      {
        id: 'f-old',
        status: 'failed',
        createdAt: new Date(NOW.getTime() - ms(31)),
      },
      {
        id: 'f-mid',
        status: 'failed',
        // 15 days old — past the dispatched window but within failed
        // retention. MUST be kept.
        createdAt: new Date(NOW.getTime() - ms(15)),
      },
      {
        id: 'f-recent',
        status: 'failed',
        createdAt: new Date(NOW.getTime() - ms(2)),
      },
    );

    const result = await proc.process(makeJob(OUTBOX_PRUNE_RECURRING_JOB));

    expect(result.deletedDispatched).toBe(0);
    expect(result.deletedFailed).toBe(1);
    expect(repo.rows.map((r) => r.id).sort()).toEqual(['f-mid', 'f-recent']);
  });

  it('never prunes pending rows regardless of age', async () => {
    const { proc, repo } = build();
    repo.rows.push(
      {
        id: 'p-old',
        status: 'pending',
        createdAt: new Date(NOW.getTime() - ms(365)),
      },
      {
        id: 'p-fresh',
        status: 'pending',
        createdAt: new Date(NOW.getTime() - ms(1)),
      },
    );

    const result = await proc.process(makeJob(OUTBOX_PRUNE_RECURRING_JOB));

    expect(result.deletedDispatched).toBe(0);
    expect(result.deletedFailed).toBe(0);
    expect(repo.rows.map((r) => r.id).sort()).toEqual(['p-fresh', 'p-old']);
  });

  it('is idempotent — re-run on the same now deletes zero', async () => {
    const { proc, repo } = build();
    repo.rows.push(
      {
        id: 'd-old',
        status: 'dispatched',
        createdAt: new Date(NOW.getTime() - ms(10)),
      },
      {
        id: 'f-old',
        status: 'failed',
        createdAt: new Date(NOW.getTime() - ms(45)),
      },
    );

    const first = await proc.process(makeJob(OUTBOX_PRUNE_RECURRING_JOB));
    expect(first.deletedDispatched).toBe(1);
    expect(first.deletedFailed).toBe(1);

    const second = await proc.process(makeJob(OUTBOX_PRUNE_RECURRING_JOB));
    expect(second.deletedDispatched).toBe(0);
    expect(second.deletedFailed).toBe(0);
    expect(repo.rows).toEqual([]);
  });

  it('reports cutoffs anchored on now=clock.now()', async () => {
    const { proc } = build();

    const result = await proc.process(makeJob(OUTBOX_PRUNE_RECURRING_JOB));

    expect(result.now).toBe(NOW.toISOString());
    expect(result.dispatchedCutoff).toBe(
      new Date(
        NOW.getTime() - OUTBOX_PRUNE_DISPATCHED_RETENTION_MS,
      ).toISOString(),
    );
    expect(result.failedCutoff).toBe(
      new Date(NOW.getTime() - OUTBOX_PRUNE_FAILED_RETENTION_MS).toISOString(),
    );
  });

  it('manual job overrides clock.now() via data.now (back-fill mode)', async () => {
    const { proc, repo } = build(new Date('2026-01-01T00:00:00.000Z'));
    const override = '2026-05-13T04:00:00.000Z';
    repo.rows.push({
      id: 'd-old',
      status: 'dispatched',
      // 10 days before the override anchor — would NOT be pruned at the
      // default clock anchor (Jan 1).
      createdAt: new Date(new Date(override).getTime() - ms(10)),
    });

    const result = await proc.process(
      makeJob(OUTBOX_PRUNE_MANUAL_JOB, { now: override }),
    );

    expect(result.now).toBe(override);
    expect(result.deletedDispatched).toBe(1);
  });

  it('rejects an unknown job name with a zero-summary no-op (defensive)', async () => {
    const { proc, repo } = build();
    repo.rows.push({
      id: 'd-old',
      status: 'dispatched',
      createdAt: new Date(NOW.getTime() - ms(10)),
    });

    const result = await proc.process(makeJob('stranger-job'));

    expect(result.deletedDispatched).toBe(0);
    expect(result.deletedFailed).toBe(0);
    // The row stayed put — no DELETE ran.
    expect(repo.rows).toHaveLength(1);
  });

  it('throws on an invalid manual `now` payload', async () => {
    const { proc } = build();

    await expect(
      proc.process(makeJob(OUTBOX_PRUNE_MANUAL_JOB, { now: 'not-a-date' })),
    ).rejects.toThrow(/outbox-prune: invalid now payload/);
  });
});
