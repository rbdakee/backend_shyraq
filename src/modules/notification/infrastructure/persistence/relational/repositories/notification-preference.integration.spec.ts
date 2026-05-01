/**
 * NotificationPreferenceRelationalRepository — integration spec.
 *
 * Self-skips when `INTEGRATION_DB !== '1'` so `npm test` stays green on
 * machines without a configured tenant DB. Run with
 *   `INTEGRATION_DB=1 npm test -- --testPathPattern notification-preference.integration`
 *
 * Coverage (T11 fix — atomic ON CONFLICT DO UPDATE upsert):
 *   1. First-insert with partial flags lets table-default populate the
 *      omitted columns (true) — preserves the opt-in default for new rows.
 *   2. Subsequent partial PATCH does NOT overwrite the unspecified
 *      column — only the specified flag is merged. Pre-fix bug: the
 *      read+merge re-wrote the unspecified column with the default value.
 *   3. Two sequential partial PATCHes from the "same user" each toggling
 *      a different flag converge to the merged state — verifies the
 *      non-clobbering merge contract that prevents the concurrent-PATCH
 *      race.
 *   4. Setting both flags explicitly works as expected.
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { UserEntity } from '@/modules/users/infrastructure/persistence/relational/entities/user.entity';
import { NotificationPreferenceTypeOrmEntity } from '../entities/notification-preference.typeorm.entity';
import { NotificationPreferenceRelationalRepository } from './notification-preference.relational-repository';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

describeIntegration(
  'NotificationPreferenceRelationalRepository — integration',
  () => {
    jest.setTimeout(60_000);

    let dataSource: DataSource;
    let userId: string;

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
        entities: [UserEntity, NotificationPreferenceTypeOrmEntity],
        synchronize: false,
        logging: false,
        poolSize: 5,
      });
      await dataSource.initialize();

      // Seed a user (notification_preferences.user_id FK).
      userId = randomUUID();
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.insert(UserEntity, {
          id: userId,
          phone: `+7700${Math.floor(Math.random() * 10_000_000)
            .toString()
            .padStart(7, '0')}`,
          full_name: 'Test User',
        });
      });
    });

    afterAll(async () => {
      if (!dataSource?.isInitialized) return;
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(
          `DELETE FROM notification_preferences WHERE user_id = $1`,
          [userId],
        );
        await m.query(`DELETE FROM users WHERE id = $1`, [userId]);
      });
      await dataSource.destroy();
    });

    beforeEach(async () => {
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(
          `DELETE FROM notification_preferences WHERE user_id = $1`,
          [userId],
        );
      });
    });

    function makeRepo(): NotificationPreferenceRelationalRepository {
      const baseRepo = dataSource.getRepository(
        NotificationPreferenceTypeOrmEntity,
      );
      return new NotificationPreferenceRelationalRepository(baseRepo);
    }

    it('first-insert with one flag set — omitted flag picks up table DEFAULT (true)', async () => {
      const repo = makeRepo();
      const rows = await repo.upsertMany(userId, [
        { eventKey: 'attendance.checkin', pushEnabled: false },
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        eventKey: 'attendance.checkin',
        pushEnabled: false,
        // Default kicks in because in_app_enabled was not in the INSERT list.
        inAppEnabled: true,
      });
    });

    it('subsequent partial PATCH does NOT clobber the unspecified flag', async () => {
      const repo = makeRepo();
      // 1) Initial state: push=false, in_app=true (default).
      await repo.upsertMany(userId, [
        { eventKey: 'attendance.checkin', pushEnabled: false },
      ]);
      // 2) PATCH only in_app to false — push must REMAIN false (not get
      //    re-defaulted to true, which was the pre-fix bug for races).
      const rows = await repo.upsertMany(userId, [
        { eventKey: 'attendance.checkin', inAppEnabled: false },
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        eventKey: 'attendance.checkin',
        pushEnabled: false,
        inAppEnabled: false,
      });
    });

    it('two sequential partial PATCHes converge to the merged state', async () => {
      const repo = makeRepo();
      // Both calls are partial and target different flags. With atomic
      // SQL merge they converge regardless of interleaving — this is the
      // contract that prevents the concurrent-PATCH clobber race.
      await repo.upsertMany(userId, [
        { eventKey: 'daily_status.changed', pushEnabled: false },
      ]);
      await repo.upsertMany(userId, [
        { eventKey: 'daily_status.changed', inAppEnabled: false },
      ]);
      const rows = await repo.upsertMany(userId, []);
      const row = rows.find((r) => r.eventKey === 'daily_status.changed');
      expect(row).toBeDefined();
      expect(row).toMatchObject({
        pushEnabled: false,
        inAppEnabled: false,
      });
    });

    it('explicit both-flag set writes both columns verbatim', async () => {
      const repo = makeRepo();
      const rows = await repo.upsertMany(userId, [
        {
          eventKey: 'timeline.entry_created',
          pushEnabled: false,
          inAppEnabled: false,
        },
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        pushEnabled: false,
        inAppEnabled: false,
      });

      // PATCH push=true alone — in_app stays false.
      const rows2 = await repo.upsertMany(userId, [
        { eventKey: 'timeline.entry_created', pushEnabled: true },
      ]);
      expect(rows2[0]).toMatchObject({
        pushEnabled: true,
        inAppEnabled: false,
      });
    });

    it('updates updated_at on every upsert', async () => {
      const repo = makeRepo();
      const first = await repo.upsertMany(userId, [
        { eventKey: 'guardian.approved', pushEnabled: false },
      ]);
      const firstAt = first[0].updatedAt.getTime();
      // small delay to make timestamps distinct
      await new Promise((r) => setTimeout(r, 5));
      const second = await repo.upsertMany(userId, [
        { eventKey: 'guardian.approved', inAppEnabled: false },
      ]);
      expect(second[0].updatedAt.getTime()).toBeGreaterThan(firstAt);
    });
  },
);
