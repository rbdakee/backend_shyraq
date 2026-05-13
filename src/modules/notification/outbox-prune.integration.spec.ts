/**
 * B22b T12 — OutboxPruneProcessor integration spec.
 *
 * Self-skips when `INTEGRATION_DB !== '1'` so `npm test` stays green on
 * machines without a configured tenant DB. Run with:
 *   INTEGRATION_DB=1 DATABASE_PORT=55432 DATABASE_USERNAME=shyraq_app \
 *     DATABASE_PASSWORD=shyraq_app \
 *     npm test -- --testPathPattern outbox-prune.integration
 *
 * Coverage:
 *   1. Seeds 8 rows across 2 kindergartens — 4 stale (2 dispatched @ 8d,
 *      2 failed @ 31d) + 4 fresh (2 dispatched @ 6d, 2 failed @ 29d).
 *   2. Runs the processor under `app.bypass_rls = 'true'`.
 *   3. Asserts ONLY the 4 stale rows are deleted; the 4 fresh ones
 *      remain regardless of tenant.
 *   4. Re-running the same tick is a no-op (idempotency).
 *   5. Pending rows are never pruned (terminal-status guard).
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { KindergartenEntity } from '@/modules/kindergarten/infrastructure/persistence/relational/entities/kindergarten.entity';
import { OutboxEventTypeOrmEntity } from './infrastructure/persistence/relational/entities/outbox-event.typeorm.entity';
import { OutboxEventRelationalRepository } from './infrastructure/persistence/relational/repositories/outbox-event.relational-repository';
import {
  OutboxPruneProcessor,
  OUTBOX_PRUNE_DISPATCHED_RETENTION_MS,
  OUTBOX_PRUNE_FAILED_RETENTION_MS,
  OUTBOX_PRUNE_RECURRING_JOB,
} from './outbox-prune.processor';
import type { Job } from 'bullmq';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

const NOW = new Date('2026-05-13T04:00:00.000Z');

function ms(days: number): number {
  return days * 24 * 60 * 60 * 1000;
}

class FixedClock extends ClockPort {
  constructor(private d: Date) {
    super();
  }
  now(): Date {
    return this.d;
  }
}

function makeJob(name: string, data: object = {}): Job {
  return { name, data } as unknown as Job;
}

describeIntegration('OutboxPruneProcessor — integration', () => {
  jest.setTimeout(60_000);

  let dataSource: DataSource;
  let kgA: string;
  let kgB: string;

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      host: process.env.DATABASE_HOST ?? 'localhost',
      port: process.env.DATABASE_PORT
        ? parseInt(process.env.DATABASE_PORT, 10)
        : 5432,
      username: process.env.DATABASE_USERNAME ?? 'shyraq',
      password: process.env.DATABASE_PASSWORD ?? 'shyraq',
      database: process.env.DATABASE_NAME ?? 'shyraq',
      entities: [KindergartenEntity, OutboxEventTypeOrmEntity],
      synchronize: false,
      logging: false,
    });
    await dataSource.initialize();

    await dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      kgA = randomUUID();
      kgB = randomUUID();
      await m.insert(KindergartenEntity, [
        { id: kgA, name: 'KG-A-Prune', slug: `kg-a-prune-${kgA}` },
        { id: kgB, name: 'KG-B-Prune', slug: `kg-b-prune-${kgB}` },
      ]);
    });
  });

  afterAll(async () => {
    if (!dataSource?.isInitialized) return;
    await dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      await m.query(
        `DELETE FROM notification_outbox WHERE kindergarten_id IN ($1, $2)`,
        [kgA, kgB],
      );
      await m.query(`DELETE FROM kindergartens WHERE id IN ($1, $2)`, [
        kgA,
        kgB,
      ]);
    });
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      await m.query(
        `DELETE FROM notification_outbox WHERE kindergarten_id IN ($1, $2)`,
        [kgA, kgB],
      );
    });
  });

  async function seed(
    rows: {
      id?: string;
      kgId: string;
      status: 'pending' | 'dispatched' | 'failed';
      createdAt: Date;
    }[],
  ): Promise<string[]> {
    const ids: string[] = [];
    await dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      for (const r of rows) {
        const id = r.id ?? randomUUID();
        ids.push(id);
        // The dispatched/failed values are terminal so `next_retry_at` is
        // not consulted; we still set a value to satisfy NOT NULL.
        // Both `$3` (status) and `$4` (createdAt) are bound multiple
        // times inside CASE expressions; cast each occurrence to its
        // explicit type so PG's parameter-type inferencer doesn't
        // deduce inconsistent types for the same slot ("inconsistent
        // types deduced for parameter $N").
        await m.query(
          `INSERT INTO notification_outbox
             (id, kindergarten_id, event_key, payload, status, attempts,
              next_retry_at, created_at, dispatched_at, failed_reason)
           VALUES ($1, $2, 'attendance.checkin', '{}'::jsonb, $3::varchar, 0,
                   $4::timestamptz, $4::timestamptz,
                   CASE WHEN $3::varchar = 'dispatched' THEN $4::timestamptz ELSE NULL END,
                   CASE WHEN $3::varchar = 'failed' THEN 'test-reason' ELSE NULL END)`,
          [id, r.kgId, r.status, r.createdAt],
        );
      }
    });
    return ids;
  }

  function makeProcessor(now: Date): OutboxPruneProcessor {
    const baseRepo = dataSource.getRepository(OutboxEventTypeOrmEntity);
    const repo = new OutboxEventRelationalRepository(baseRepo);
    const clock = new FixedClock(now);
    return new OutboxPruneProcessor(repo, dataSource, clock);
  }

  async function readBackIds(): Promise<string[]> {
    return dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      const rows: Array<{ id: string }> = await m.query(
        `SELECT id FROM notification_outbox
          WHERE kindergarten_id IN ($1, $2)
          ORDER BY created_at`,
        [kgA, kgB],
      );
      return rows.map((r) => r.id);
    });
  }

  it('deletes only the 4 stale rows across both kindergartens; keeps the 4 fresh ones', async () => {
    const stale = await seed([
      // 2 dispatched stale (8d old, past 7d cutoff)
      {
        kgId: kgA,
        status: 'dispatched',
        createdAt: new Date(NOW.getTime() - ms(8)),
      },
      {
        kgId: kgB,
        status: 'dispatched',
        createdAt: new Date(NOW.getTime() - ms(9)),
      },
      // 2 failed stale (31d old, past 30d cutoff)
      {
        kgId: kgA,
        status: 'failed',
        createdAt: new Date(NOW.getTime() - ms(31)),
      },
      {
        kgId: kgB,
        status: 'failed',
        createdAt: new Date(NOW.getTime() - ms(45)),
      },
    ]);
    const fresh = await seed([
      // 2 dispatched fresh (6d old, within 7d cutoff — kept)
      {
        kgId: kgA,
        status: 'dispatched',
        createdAt: new Date(NOW.getTime() - ms(6)),
      },
      {
        kgId: kgB,
        status: 'dispatched',
        createdAt: new Date(NOW.getTime() - ms(3)),
      },
      // 2 failed fresh (29d old, within 30d cutoff — kept)
      {
        kgId: kgA,
        status: 'failed',
        createdAt: new Date(NOW.getTime() - ms(29)),
      },
      {
        kgId: kgB,
        status: 'failed',
        createdAt: new Date(NOW.getTime() - ms(10)),
      },
    ]);

    const proc = makeProcessor(NOW);
    const summary = await proc.process(makeJob(OUTBOX_PRUNE_RECURRING_JOB));

    expect(summary.deletedDispatched).toBe(2);
    expect(summary.deletedFailed).toBe(2);
    expect(summary.now).toBe(NOW.toISOString());
    expect(summary.dispatchedCutoff).toBe(
      new Date(
        NOW.getTime() - OUTBOX_PRUNE_DISPATCHED_RETENTION_MS,
      ).toISOString(),
    );
    expect(summary.failedCutoff).toBe(
      new Date(NOW.getTime() - OUTBOX_PRUNE_FAILED_RETENTION_MS).toISOString(),
    );

    const remaining = await readBackIds();
    expect(remaining.sort()).toEqual([...fresh].sort());
    for (const id of stale) {
      expect(remaining).not.toContain(id);
    }
  });

  it('is idempotent — re-running the same tick deletes zero', async () => {
    await seed([
      {
        kgId: kgA,
        status: 'dispatched',
        createdAt: new Date(NOW.getTime() - ms(10)),
      },
      {
        kgId: kgB,
        status: 'failed',
        createdAt: new Date(NOW.getTime() - ms(45)),
      },
    ]);

    const proc = makeProcessor(NOW);
    const first = await proc.process(makeJob(OUTBOX_PRUNE_RECURRING_JOB));
    expect(first.deletedDispatched).toBe(1);
    expect(first.deletedFailed).toBe(1);

    const second = await proc.process(makeJob(OUTBOX_PRUNE_RECURRING_JOB));
    expect(second.deletedDispatched).toBe(0);
    expect(second.deletedFailed).toBe(0);

    const remaining = await readBackIds();
    expect(remaining).toEqual([]);
  });

  it('never prunes pending rows regardless of age', async () => {
    const ids = await seed([
      // 1 year old pending — must be kept (failure mode would be a
      // pending row stuck forever, but the dispatcher's
      // markFailedWithRetry already terminates after MAX attempts, so a
      // row this old is a real bug surfacing in the audit — the pruner
      // must NOT silently bury it).
      {
        kgId: kgA,
        status: 'pending',
        createdAt: new Date(NOW.getTime() - ms(365)),
      },
    ]);

    const proc = makeProcessor(NOW);
    const summary = await proc.process(makeJob(OUTBOX_PRUNE_RECURRING_JOB));

    expect(summary.deletedDispatched).toBe(0);
    expect(summary.deletedFailed).toBe(0);
    const remaining = await readBackIds();
    expect(remaining).toEqual(ids);
  });
});
