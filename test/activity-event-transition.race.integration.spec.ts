/**
 * F11 — concurrent activity_event status-transition race.
 *
 * Self-skips when `INTEGRATION_DB !== '1'` so `npm test` stays green on
 * machines without a configured tenant DB. Run with:
 *
 *   INTEGRATION_DB=1 DATABASE_USERNAME=shyraq_app DATABASE_PASSWORD=shyraq_app \
 *   npm test -- --testPathPattern activity-event-transition.race.integration
 *
 * What this guards: two admin clicks racing over the same `scheduled` event
 * (e.g. start + cancel). Without the conditional UPDATE, both reads see
 * `status='scheduled'`, both pass domain validation (`scheduled → in_progress`
 * AND `scheduled → cancelled` are both valid), and both blindly UPDATE — last
 * writer wins. After the fix, `updateWithExpectedStatus` adds
 * `WHERE status = <expected_old>` so only one caller observes affected = 1.
 *
 * The spec runs 5 concurrent transitions (mix of start + cancel) against the
 * same scheduled event. Post-conditions:
 *   - Exactly 1 caller resolves `true` (winner).
 *   - 4 callers resolve `false` (losers — service maps to 409).
 *   - DB row ends up at exactly one terminal/intermediate status.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { ActivityEvent } from '@/modules/schedule/domain/entities/activity-event.entity';
import { ActivityEventEntity } from '@/modules/schedule/infrastructure/persistence/relational/entities/activity-event.entity';
import { ActivityEventRelationalRepository } from '@/modules/schedule/infrastructure/persistence/relational/repositories/activity-event-relational.repository';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

const FIXED_NOW = new Date('2026-04-30T10:00:00.000Z');
const fixedClock = { now: () => FIXED_NOW };

describeIntegration(
  'ActivityEventRepository.updateWithExpectedStatus — concurrent transition race (F11)',
  () => {
    jest.setTimeout(60_000);

    let dataSource: DataSource;
    let kgId: string;
    let groupId: string;
    let eventId: string;

    beforeAll(async () => {
      dataSource = new DataSource({
        type: 'postgres',
        host: process.env.DATABASE_HOST ?? 'localhost',
        port: process.env.DATABASE_PORT
          ? parseInt(process.env.DATABASE_PORT, 10)
          : 5432,
        username: process.env.DATABASE_USERNAME ?? 'shyraq_app',
        password: process.env.DATABASE_PASSWORD ?? 'shyraq_app',
        database: process.env.DATABASE_NAME ?? 'shyraq',
        entities: [ActivityEventEntity],
        synchronize: false,
        logging: false,
        poolSize: 10,
      });
      await dataSource.initialize();
    });

    afterAll(async () => {
      if (!dataSource?.isInitialized) return;
      await dataSource.destroy();
    });

    beforeEach(async () => {
      kgId = randomUUID();
      groupId = randomUUID();
      eventId = randomUUID();

      const kgSlug = `evt-race-${kgId.slice(0, 8)}`;

      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(
          `INSERT INTO kindergartens (id, name, slug, is_active)
           VALUES ($1, 'Event Race KG', $2, true)`,
          [kgId, kgSlug],
        );
        await m.query(
          `INSERT INTO groups (id, kindergarten_id, name, capacity)
           VALUES ($1, $2, 'Race Group', 20)`,
          [groupId, kgId],
        );
        await m.query(
          `INSERT INTO activity_events
             (id, kindergarten_id, group_id, activity_name, starts_at, status,
              created_at, updated_at)
           VALUES ($1, $2, $3, 'Race Event', $4, 'scheduled', $5, $5)`,
          [eventId, kgId, groupId, FIXED_NOW, FIXED_NOW],
        );
      });
    });

    afterEach(async () => {
      if (!dataSource?.isInitialized) return;
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(
          `DELETE FROM activity_events WHERE kindergarten_id = $1`,
          [kgId],
        );
        await m.query(`DELETE FROM groups WHERE kindergarten_id = $1`, [kgId]);
        await m.query(`DELETE FROM kindergartens WHERE id = $1`, [kgId]);
      });
    });

    async function runInTenantTx<T>(fn: () => Promise<T>): Promise<T> {
      return dataSource.transaction(async (manager) => {
        // PG `SET LOCAL` does not support parameter binding.
        await manager.query(`SET LOCAL app.kindergarten_id = '${kgId}'`);
        return tenantStorage.run(
          {
            kgId,
            bypass: false,
            entityManager: manager,
          },
          fn,
        );
      });
    }

    async function loadEvent(): Promise<ActivityEvent> {
      return dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        const row = await m.getRepository(ActivityEventEntity).findOneOrFail({
          where: { id: eventId },
        });
        return ActivityEvent.hydrate({
          id: row.id,
          kindergartenId: row.kindergarten_id,
          groupId: row.group_id,
          templateSlotId: row.template_slot_id,
          activityName: row.activity_name,
          locationId: row.location_id,
          startsAt: row.starts_at,
          endsAt: row.ends_at,
          status: row.status,
          createdBy: row.created_by,
          notes: row.notes,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        });
      });
    }

    it('serializes concurrent start vs cancel on a scheduled event — exactly one wins', async () => {
      const repo = new ActivityEventRelationalRepository(
        dataSource.getRepository(ActivityEventEntity),
      );

      // Build two in-memory copies that BOTH started from status='scheduled'.
      const baseStart = await loadEvent();
      baseStart.start(fixedClock); // mutates to in_progress in memory
      const baseCancel = await loadEvent();
      baseCancel.cancel('weather', fixedClock); // mutates to cancelled in memory

      // Mirror service: 5 concurrent calls, mix of start + cancel, each
      // claiming `expected = 'scheduled'`. The DB row starts as scheduled,
      // so only the FIRST conditional UPDATE flips status — the rest see 0
      // affected rows.
      const tasks = [
        () => repo.updateWithExpectedStatus(kgId, baseStart, 'scheduled'),
        () => repo.updateWithExpectedStatus(kgId, baseCancel, 'scheduled'),
        () => repo.updateWithExpectedStatus(kgId, baseStart, 'scheduled'),
        () => repo.updateWithExpectedStatus(kgId, baseCancel, 'scheduled'),
        () => repo.updateWithExpectedStatus(kgId, baseStart, 'scheduled'),
      ];

      const results = await Promise.all(tasks.map((t) => runInTenantTx(t)));

      const winners = results.filter((r) => r === true);
      const losers = results.filter((r) => r === false);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(4);

      // DB invariant — status moved off 'scheduled' exactly once.
      const rows = (await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        return m.query(`SELECT status FROM activity_events WHERE id = $1`, [
          eventId,
        ]);
      })) as Array<{ status: string }>;

      expect(rows).toHaveLength(1);
      expect(['in_progress', 'cancelled']).toContain(rows[0].status);
    });

    it('returns false when the row already moved off the expected status', async () => {
      const repo = new ActivityEventRelationalRepository(
        dataSource.getRepository(ActivityEventEntity),
      );

      // First caller wins.
      const startEv = await loadEvent();
      startEv.start(fixedClock);
      const first = await runInTenantTx(() =>
        repo.updateWithExpectedStatus(kgId, startEv, 'scheduled'),
      );
      expect(first).toBe(true);

      // Second caller (still holding a stale copy that observed 'scheduled')
      // tries to cancel — the row is already 'in_progress', so 0 rows match.
      const cancelEv = ActivityEvent.hydrate({
        ...startEv.toState(),
        status: 'cancelled',
      });
      const second = await runInTenantTx(() =>
        repo.updateWithExpectedStatus(kgId, cancelEv, 'scheduled'),
      );
      expect(second).toBe(false);
    });
  },
);
