/**
 * PushTokenRelationalRepository — integration spec.
 *
 * Self-skips when `INTEGRATION_DB !== '1'` so `npm test` stays green on
 * machines without a configured tenant DB. Run with:
 *   `INTEGRATION_DB=1 npm test -- --testPathPattern push-token.integration`
 *
 * Coverage (B9 review HIGH#3 — globally unique by (platform, token) +
 * ownership-transfer semantics):
 *   1. First insert creates a row owned by the caller.
 *   2. Same user re-registering the same (platform, token) refreshes the
 *      row in place — same id, updated last_seen_at / app_version.
 *   3. DIFFERENT user re-registering the same (platform, token) transfers
 *      ownership atomically: row.user_id flips, only ONE row remains.
 *      Pre-fix bug allowed two rows; this asserts the cross-user push
 *      leak is closed at the SQL level.
 *   4. Same token under different platforms (ios + android) → two rows.
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { UserEntity } from '@/modules/users/infrastructure/persistence/relational/entities/user.entity';
import { PushTokenTypeOrmEntity } from '../entities/push-token.typeorm.entity';
import { PushTokenRelationalRepository } from './push-token.relational-repository';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

describeIntegration('PushTokenRelationalRepository — integration', () => {
  jest.setTimeout(60_000);

  let dataSource: DataSource;
  let userA: string;
  let userB: string;

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
      entities: [UserEntity, PushTokenTypeOrmEntity],
      synchronize: false,
      logging: false,
      poolSize: 5,
    });
    await dataSource.initialize();

    // Seed two users — push_tokens.user_id has a FK to users.
    userA = randomUUID();
    userB = randomUUID();
    await dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      await m.insert(UserEntity, [
        {
          id: userA,
          phone: `+7700${Math.floor(Math.random() * 10_000_000)
            .toString()
            .padStart(7, '0')}`,
          full_name: 'PushToken User A',
        },
        {
          id: userB,
          phone: `+7700${Math.floor(Math.random() * 10_000_000)
            .toString()
            .padStart(7, '0')}`,
          full_name: 'PushToken User B',
        },
      ]);
    });
  });

  afterAll(async () => {
    if (!dataSource?.isInitialized) return;
    await dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      await m.query(`DELETE FROM push_tokens WHERE user_id = ANY($1)`, [
        [userA, userB],
      ]);
      await m.query(`DELETE FROM users WHERE id = ANY($1)`, [[userA, userB]]);
    });
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      await m.query(`DELETE FROM push_tokens WHERE user_id = ANY($1)`, [
        [userA, userB],
      ]);
    });
  });

  function makeRepo(): PushTokenRelationalRepository {
    const baseRepo = dataSource.getRepository(PushTokenTypeOrmEntity);
    return new PushTokenRelationalRepository(baseRepo);
  }

  it('first insert creates a row owned by the caller', async () => {
    const repo = makeRepo();
    const row = await repo.upsert({
      userId: userA,
      token: 'fcm-T1',
      platform: 'android',
      appVersion: '1.0.0',
      deviceId: 'device-A',
    });
    expect(row.userId).toBe(userA);
    expect(row.token).toBe('fcm-T1');
    expect(row.platform).toBe('android');
    expect(row.id).toBeDefined();
  });

  it('same user re-registering same (platform, token) refreshes the row in place', async () => {
    const repo = makeRepo();
    const first = await repo.upsert({
      userId: userA,
      token: 'fcm-T1',
      platform: 'android',
      appVersion: '1.0.0',
    });
    // small delay so last_seen_at strictly advances.
    await new Promise((r) => setTimeout(r, 5));
    const second = await repo.upsert({
      userId: userA,
      token: 'fcm-T1',
      platform: 'android',
      appVersion: '2.0.0',
    });

    expect(second.id).toBe(first.id);
    expect(second.appVersion).toBe('2.0.0');
    expect(second.lastSeenAt.getTime()).toBeGreaterThan(
      first.lastSeenAt.getTime(),
    );

    // Exactly one row in DB.
    const count = await dataSource.manager.query<{ c: string }[]>(
      `SELECT count(*)::text AS c FROM push_tokens WHERE token = $1 AND platform = $2`,
      ['fcm-T1', 'android'],
    );
    expect(count[0].c).toBe('1');
  });

  it('different user re-registering same (platform, token) transfers ownership atomically', async () => {
    const repo = makeRepo();
    // User A registers first.
    const original = await repo.upsert({
      userId: userA,
      token: 'fcm-shared',
      platform: 'android',
      deviceId: 'device-shared',
    });

    // User B re-registers the same (platform, token) — phone changed
    // hands. With the new (platform, token) UNIQUE the upsert MUST
    // transfer ownership instead of inserting a second row.
    const transferred = await repo.upsert({
      userId: userB,
      token: 'fcm-shared',
      platform: 'android',
    });

    expect(transferred.userId).toBe(userB);
    // Same row id — atomic transfer, not insert+delete.
    expect(transferred.id).toBe(original.id);

    // Exactly ONE row in DB. Pre-fix bug allowed two rows here, leaking
    // user A's push notifications to user B's device.
    const rows = await dataSource.manager.query<
      { id: string; user_id: string }[]
    >(
      `SELECT id, user_id FROM push_tokens WHERE token = $1 AND platform = $2`,
      ['fcm-shared', 'android'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(userB);
  });

  it('same token under different platforms creates two independent rows', async () => {
    const repo = makeRepo();
    await repo.upsert({
      userId: userA,
      token: 'cross-platform',
      platform: 'ios',
    });
    await repo.upsert({
      userId: userA,
      token: 'cross-platform',
      platform: 'android',
    });

    const rows = await dataSource.manager.query<{ platform: string }[]>(
      `SELECT platform FROM push_tokens WHERE token = 'cross-platform' ORDER BY platform`,
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.platform)).toEqual(['android', 'ios']);
  });
});
