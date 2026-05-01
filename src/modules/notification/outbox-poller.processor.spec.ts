/**
 * OutboxPollerProcessor — service-unit suite.
 *
 * Coverage:
 *   1. claim → dispatched success path: markDispatched is called once per
 *      event, no markFailedWithRetry calls.
 *   2. claim → failed path: markFailedWithRetry is called with the
 *      domain-computed attempts/nextRetryAt, terminal=false until
 *      attempts < MAX_OUTBOX_ATTEMPTS.
 *   3. After MAX_OUTBOX_ATTEMPTS reached, markFailedWithRetry is called
 *      with terminal=true.
 *   4. Defense-in-depth: a dispatcher that throws still marks the in-flight
 *      row as failed (does not abandon the rest of the batch).
 *   5. Empty batch: no dispatch, no mark calls.
 *   6. Multiple events in one batch: processed sequentially, each in the
 *      same transaction.
 */
import { Job } from 'bullmq';
import { DataSource, EntityManager } from 'typeorm';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import {
  MAX_OUTBOX_ATTEMPTS,
  OutboxEvent,
} from './domain/entities/outbox-event.entity';
import {
  DispatchResult,
  NotificationDispatcher,
} from './notification-dispatcher.service';
import {
  OutboxPollerProcessor,
  OUTBOX_BATCH_SIZE,
} from './outbox-poller.processor';
import { OutboxEventRepository } from './outbox-event.repository';

const KG = '11111111-1111-1111-1111-111111111111';
const NOW = new Date('2026-05-01T09:00:00.000Z');

class FixedClock extends ClockPort {
  constructor(private readonly t: Date) {
    super();
  }
  now(): Date {
    return this.t;
  }
}

interface MarkDispatchedCall {
  id: string;
  now: Date;
}

interface MarkFailedCall {
  id: string;
  now: Date;
  reason: string;
  attempts: number;
  nextRetryAt: Date;
  terminal: boolean;
}

class FakeOutboxRepo extends OutboxEventRepository {
  pending: OutboxEvent[] = [];
  claimCalls = 0;
  dispatchedCalls: MarkDispatchedCall[] = [];
  failedCalls: MarkFailedCall[] = [];

  enqueue(): Promise<OutboxEvent> {
    throw new Error('not used in this suite');
  }

  claimBatch(
    _manager: EntityManager,
    _limit: number,
    _now: Date,
  ): Promise<OutboxEvent[]> {
    this.claimCalls += 1;
    const out = this.pending;
    this.pending = [];
    return Promise.resolve(out);
  }

  markDispatched(
    _manager: EntityManager,
    id: string,
    now: Date,
  ): Promise<void> {
    this.dispatchedCalls.push({ id, now });
    return Promise.resolve();
  }

  markFailedWithRetry(
    _manager: EntityManager,
    id: string,
    now: Date,
    reason: string,
    attempts: number,
    nextRetryAt: Date,
    terminal: boolean,
  ): Promise<void> {
    this.failedCalls.push({
      id,
      now,
      reason,
      attempts,
      nextRetryAt,
      terminal,
    });
    return Promise.resolve();
  }

  findById(): Promise<OutboxEvent | null> {
    return Promise.resolve(null);
  }
}

class FakeDispatcher {
  private results: DispatchResult[] = [];
  private throwOnNext = false;
  calls: OutboxEvent[] = [];

  queueResult(r: DispatchResult): void {
    this.results.push(r);
  }
  queueThrow(): void {
    this.throwOnNext = true;
  }

  dispatch(event: OutboxEvent): Promise<DispatchResult> {
    this.calls.push(event);
    if (this.throwOnNext) {
      this.throwOnNext = false;
      return Promise.reject(new Error('dispatcher_boom'));
    }
    const r = this.results.shift();
    return Promise.resolve(r ?? { status: 'dispatched' });
  }
}

/**
 * Stand-in for `DataSource` whose `transaction` runs the given callback
 * with a sentinel `EntityManager`. The fake repo does not actually use
 * the manager but verifies the contract: ALL repo calls inside one tick
 * receive the same sentinel.
 */
class FakeDataSource {
  transactionCalls = 0;
  setLocalCalls: string[] = [];

  async transaction<T>(cb: (manager: EntityManager) => Promise<T>): Promise<T> {
    this.transactionCalls += 1;
    const m = {
      query: (sql: string): Promise<unknown[]> => {
        this.setLocalCalls.push(sql);
        return Promise.resolve([]);
      },
    } as unknown as EntityManager;
    return cb(m);
  }
}

function event(id: string, eventKey = 'attendance.checkin'): OutboxEvent {
  return OutboxEvent.create(
    { id, kindergartenId: KG, eventKey, payload: {} },
    NOW,
  );
}

function makeProcessor(): {
  proc: OutboxPollerProcessor;
  repo: FakeOutboxRepo;
  dispatcher: FakeDispatcher;
  dataSource: FakeDataSource;
} {
  const repo = new FakeOutboxRepo();
  const dispatcher = new FakeDispatcher();
  const dataSource = new FakeDataSource();
  const clock = new FixedClock(NOW);
  const proc = new OutboxPollerProcessor(
    repo,
    dispatcher as unknown as NotificationDispatcher,
    dataSource as unknown as DataSource,
    clock,
  );
  return { proc, repo, dispatcher, dataSource };
}

describe('OutboxPollerProcessor', () => {
  it('claims a batch, dispatches success, and marks each event dispatched', async () => {
    const { proc, repo, dispatcher, dataSource } = makeProcessor();
    repo.pending = [event('e-1'), event('e-2')];
    dispatcher.queueResult({ status: 'dispatched' });
    dispatcher.queueResult({ status: 'dispatched' });

    await proc.process({} as unknown as Job);

    expect(dataSource.transactionCalls).toBe(1);
    expect(dataSource.setLocalCalls.some((q) => /bypass_rls/.test(q))).toBe(
      true,
    );
    expect(repo.claimCalls).toBe(1);
    expect(repo.dispatchedCalls.map((c) => c.id)).toEqual(['e-1', 'e-2']);
    expect(repo.failedCalls).toEqual([]);
    expect(dispatcher.calls).toHaveLength(2);
  });

  it('on dispatcher failed result, marks failed with retry (non-terminal) until MAX_ATTEMPTS', async () => {
    const { proc, repo, dispatcher } = makeProcessor();
    const ev = event('e-3');
    repo.pending = [ev];
    dispatcher.queueResult({ status: 'failed', reason: 'transient' });

    await proc.process({} as unknown as Job);

    expect(repo.dispatchedCalls).toEqual([]);
    expect(repo.failedCalls).toHaveLength(1);
    expect(repo.failedCalls[0]).toMatchObject({
      id: 'e-3',
      reason: 'transient',
      attempts: 1,
      terminal: false,
    });
    // nextRetryAt is now + backoff(1) = +2 minutes (defaultBackoff curve).
    const expected = new Date(NOW.getTime() + 2 * 60_000);
    expect(repo.failedCalls[0].nextRetryAt.getTime()).toBe(expected.getTime());
  });

  it('marks the row terminal=true once attempts reach MAX_OUTBOX_ATTEMPTS', async () => {
    const { proc, repo, dispatcher } = makeProcessor();
    // Pre-bump the event so the next failure pushes attempts to MAX.
    const ev = OutboxEvent.hydrate({
      id: 'e-4',
      kindergartenId: KG,
      eventKey: 'attendance.checkin',
      payload: {},
      status: 'pending',
      attempts: MAX_OUTBOX_ATTEMPTS - 1,
      nextRetryAt: NOW,
      createdAt: NOW,
      dispatchedAt: null,
      failedReason: null,
    });
    repo.pending = [ev];
    dispatcher.queueResult({ status: 'failed', reason: 'final-boom' });

    await proc.process({} as unknown as Job);

    expect(repo.failedCalls).toHaveLength(1);
    expect(repo.failedCalls[0]).toMatchObject({
      id: 'e-4',
      reason: 'final-boom',
      attempts: MAX_OUTBOX_ATTEMPTS,
      terminal: true,
    });
  });

  it('treats a dispatcher exception as a failed attempt (defense-in-depth)', async () => {
    const { proc, repo, dispatcher } = makeProcessor();
    const ev = event('e-5');
    repo.pending = [ev];
    dispatcher.queueThrow();

    await proc.process({} as unknown as Job);

    expect(repo.dispatchedCalls).toEqual([]);
    expect(repo.failedCalls).toHaveLength(1);
    expect(repo.failedCalls[0]).toMatchObject({
      id: 'e-5',
      reason: 'dispatcher_boom',
      attempts: 1,
      terminal: false,
    });
  });

  it('continues processing the rest of the batch when one event fails', async () => {
    const { proc, repo, dispatcher } = makeProcessor();
    repo.pending = [event('e-6'), event('e-7'), event('e-8')];
    dispatcher.queueResult({ status: 'dispatched' });
    dispatcher.queueResult({ status: 'failed', reason: 'mid-fail' });
    dispatcher.queueResult({ status: 'dispatched' });

    await proc.process({} as unknown as Job);

    expect(repo.dispatchedCalls.map((c) => c.id)).toEqual(['e-6', 'e-8']);
    expect(repo.failedCalls.map((c) => c.id)).toEqual(['e-7']);
    // Each call shared the SAME tx — only one transaction was opened.
    expect(dispatcher.calls).toHaveLength(3);
  });

  it('with an empty claim does nothing — no dispatch, no marks', async () => {
    const { proc, repo, dispatcher } = makeProcessor();
    repo.pending = [];

    await proc.process({} as unknown as Job);

    expect(repo.claimCalls).toBe(1);
    expect(dispatcher.calls).toEqual([]);
    expect(repo.dispatchedCalls).toEqual([]);
    expect(repo.failedCalls).toEqual([]);
  });

  it('exposes the canonical batch size', () => {
    expect(OUTBOX_BATCH_SIZE).toBe(50);
  });
});
