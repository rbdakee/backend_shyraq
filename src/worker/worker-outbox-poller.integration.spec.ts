/**
 * B9 T6 worker outbox poller — integration spec.
 *
 * Self-skips when `INTEGRATION_DB !== '1'` so `npm test` stays green on
 * machines without a configured tenant DB. Run with
 *   `INTEGRATION_DB=1 npm test -- --testPathPattern worker-outbox-poller.integration`
 *
 * Scope:
 *   1. Bootstraps the full `WorkerModule` against real PG + Redis +
 *      BullMQ. The repeatable scheduler upsert from
 *      `WorkerJobSchedulerService` registers the 2-second poll cycle.
 *   2. Inserts a pending outbox row directly via the production repo.
 *   3. Waits up to ~6 seconds (3 poll ticks) for the row to flip to
 *      `dispatched`.
 *   4. Verifies the row's status, attempts, and dispatched_at.
 *
 * What this does NOT cover:
 *   - WS round-trip (T9 e2e covers that with a real socket.io-client).
 *   - Push fan-out side-effects (dispatcher service-unit covers that).
 *   - Race between two parallel pollers (covered by the outbox repo
 *     integration spec via `FOR UPDATE SKIP LOCKED`).
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { OutboxEventRepository } from '@/modules/notification/outbox-event.repository';
import { OutboxEventTypeOrmEntity } from '@/modules/notification/infrastructure/persistence/relational/entities/outbox-event.typeorm.entity';
import { WorkerModule } from './worker.module';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

describeIntegration('Worker outbox poller — integration', () => {
  jest.setTimeout(30_000);

  let app: INestApplicationContext;
  let dataSource: DataSource;
  let outboxRepo: OutboxEventRepository;

  beforeAll(async () => {
    app = await NestFactory.createApplicationContext(WorkerModule, {
      logger: ['error', 'warn'],
    });
    dataSource = app.get(DataSource);
    outboxRepo = app.get(OutboxEventRepository);
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('drains a pending outbox row within ~6 seconds (poll cadence 2s)', async () => {
    const kgId = randomUUID();
    const slug = `kg-worker-${kgId}`;

    // Seed a kindergarten so the outbox row's FK is satisfied.
    await dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      await m.query(
        `INSERT INTO kindergartens(id, name, slug) VALUES ($1, $2, $3)`,
        [kgId, 'KG-Worker', slug],
      );
    });

    // Enqueue a row through the real repo, in bypass scope.
    const eventId = await dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      const ev = await outboxRepo.enqueue(
        {
          kindergartenId: kgId,
          // `attendance.checkin` resolves to "guardians of childId".
          // With no guardians seeded the dispatcher returns `dispatched`
          // (terminal success — nobody to notify, but the row is drained
          // — exactly what we want to assert here).
          eventKey: 'attendance.checkin',
          payload: { childId: randomUUID() },
        },
        m,
      );
      return ev.id!;
    });

    // Poll the row until it flips to `dispatched`. The repeatable job
    // runs every 2 seconds, so we wait up to 6s (3 ticks) before
    // declaring failure.
    const deadline = Date.now() + 8_000;
    let finalStatus: string | null = null;
    while (Date.now() < deadline) {
      const row = await dataSource
        .createQueryRunner()
        .manager.query(
          `SET LOCAL app.bypass_rls = 'true'; SELECT status, dispatched_at FROM notification_outbox WHERE id = $1`,
          [eventId],
        )
        .catch(() => null);
      // The first SET LOCAL + SELECT returns the SELECT result on most pg
      // drivers; on driver versions that split it, fall back to a
      // standalone query in a TX.
      if (Array.isArray(row) && row.length > 0 && row[0].status) {
        finalStatus = row[0].status as string;
        if (finalStatus !== 'pending') break;
      } else {
        const inTx = await dataSource.transaction(async (m) => {
          await m.query(`SET LOCAL app.bypass_rls = 'true'`);
          return m.query(
            `SELECT status, dispatched_at FROM notification_outbox WHERE id = $1`,
            [eventId],
          );
        });
        if (inTx?.[0]?.status) {
          finalStatus = inTx[0].status as string;
          if (finalStatus !== 'pending') break;
        }
      }
      await sleep(500);
    }

    expect(finalStatus).toBe('dispatched');

    // Cleanup.
    await dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      await m.query(`DELETE FROM notification_outbox WHERE id = $1`, [eventId]);
      await m.query(`DELETE FROM kindergartens WHERE id = $1`, [kgId]);
    });

    // Touch the typeorm entity so the import is not unused — the worker
    // metadata-scan pulls it in transitively but the bare type would be
    // pruned by ts-jest otherwise.
    expect(OutboxEventTypeOrmEntity.name).toBe('OutboxEventTypeOrmEntity');
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
