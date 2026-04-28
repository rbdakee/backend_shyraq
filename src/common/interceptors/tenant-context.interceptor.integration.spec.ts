/**
 * Integration spec for TenantContextInterceptor + RLS plumbing.
 *
 * Phantom-row pattern: insert refresh_tokens for two distinct kindergartens,
 * then verify that — inside a transaction with `SET LOCAL
 * app.kindergarten_id` — only the matching tenant's row is visible. With
 * `app.bypass_rls = 'true'` both rows are visible. Without either GUC, RLS
 * blocks reads to zero rows.
 *
 * The spec connects to a real Postgres because RLS policies cannot be
 * exercised against a mock. It self-skips when no DB is reachable so
 * `npm test` stays green on machines without a configured tenant DB
 * (developer laptops without docker, CI shards without postgres). To run
 * locally:
 *
 *   docker compose -f docker-compose.relational.test.yaml up -d postgres
 *   DATABASE_HOST=localhost DATABASE_PORT=5432 \\
 *     DATABASE_USERNAME=shyraq DATABASE_PASSWORD=shyraq \\
 *     DATABASE_NAME=shyraq npm run migration:run
 *   INTEGRATION_DB=1 DATABASE_HOST=localhost DATABASE_PORT=5432 \\
 *     DATABASE_USERNAME=shyraq DATABASE_PASSWORD=shyraq \\
 *     DATABASE_NAME=shyraq npm test -- tenant-context.interceptor.integration
 */
import 'reflect-metadata';
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { defer, firstValueFrom, lastValueFrom } from 'rxjs';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { tenantStorage } from '@/database/tenant-storage';
import { KindergartenEntity } from '@/modules/kindergarten/infrastructure/persistence/relational/entities/kindergarten.entity';
import { UserEntity } from '@/modules/users/infrastructure/persistence/relational/entities/user.entity';
import { RefreshTokenEntity } from '@/modules/auth/infrastructure/persistence/relational/entities/refresh-token.entity';
import { SaasUserEntity } from '@/modules/auth/infrastructure/persistence/relational/entities/saas-user.entity';
import { SaasRefreshTokenEntity } from '@/modules/auth/infrastructure/persistence/relational/entities/saas-refresh-token.entity';
import { TenantContextInterceptor } from './tenant-context.interceptor';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

describeIntegration('TenantContextInterceptor (integration)', () => {
  jest.setTimeout(60_000);

  let dataSource: DataSource;
  let kgA: string;
  let kgB: string;
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
      entities: [
        KindergartenEntity,
        UserEntity,
        RefreshTokenEntity,
        SaasUserEntity,
        SaasRefreshTokenEntity,
      ],
      synchronize: false,
      logging: false,
    });
    await dataSource.initialize();

    // Seed two kindergartens + two users + one refresh_token per kg. Done with
    // BYPASSRLS so we can write across both tenants regardless of policies.
    await dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      kgA = randomUUID();
      kgB = randomUUID();
      userA = randomUUID();
      userB = randomUUID();
      await m.insert(KindergartenEntity, [
        { id: kgA, name: 'KG-A', slug: `kg-a-${kgA}` },
        { id: kgB, name: 'KG-B', slug: `kg-b-${kgB}` },
      ]);
      await m.insert(UserEntity, [
        { id: userA, phone: `+7700${kgA.slice(0, 7)}`, full_name: 'A' },
        { id: userB, phone: `+7700${kgB.slice(0, 7)}`, full_name: 'B' },
      ]);
      await m.insert(RefreshTokenEntity, [
        {
          user_id: userA,
          kindergarten_id: kgA,
          token_hash: `hash-A-${kgA}`,
          device_id: null,
          ip_address: null,
          expires_at: new Date(Date.now() + 86_400_000),
        },
        {
          user_id: userB,
          kindergarten_id: kgB,
          token_hash: `hash-B-${kgB}`,
          device_id: null,
          ip_address: null,
          expires_at: new Date(Date.now() + 86_400_000),
        },
      ]);
    });
  });

  afterAll(async () => {
    if (!dataSource?.isInitialized) return;
    await dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      await m.query(`DELETE FROM refresh_tokens WHERE user_id IN ($1, $2)`, [
        userA,
        userB,
      ]);
      await m.query(`DELETE FROM users WHERE id IN ($1, $2)`, [userA, userB]);
      await m.query(`DELETE FROM kindergartens WHERE id IN ($1, $2)`, [
        kgA,
        kgB,
      ]);
    });
    await dataSource.destroy();
  });

  function makeCtx(req: Record<string, unknown>): ExecutionContext {
    return {
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
  }

  /**
   * Builds a CallHandler whose `handle()` runs the supplied async work inside
   * the active tenantStorage scope. Mirrors how a real NestJS handler runs
   * after the interceptor establishes ALS.
   */
  function nextRunning<T>(work: () => Promise<T>): CallHandler {
    return {
      handle: () => defer(() => work()),
    };
  }

  it('isolates KG-A from KG-B inside SET LOCAL app.kindergarten_id', async () => {
    const interceptor = new TenantContextInterceptor(dataSource);
    const next = nextRunning(async () => {
      const ctx = tenantStorage.getStore();
      expect(ctx?.entityManager).toBeDefined();
      const rows = (await ctx!.entityManager!.query(
        `SELECT user_id, kindergarten_id FROM refresh_tokens WHERE kindergarten_id IN ($1, $2)`,
        [kgA, kgB],
      )) as Array<{ user_id: string; kindergarten_id: string }>;
      return rows;
    });
    const result = (await lastValueFrom(
      interceptor.intercept(
        makeCtx({ tenant: { kgId: kgA, bypass: false } }),
        next,
      ),
    )) as Array<{ user_id: string; kindergarten_id: string }>;
    expect(result).toHaveLength(1);
    expect(result[0].kindergarten_id).toBe(kgA);
    expect(result[0].user_id).toBe(userA);
  });

  it('exposes both rows under bypass=true (SET LOCAL app.bypass_rls)', async () => {
    const interceptor = new TenantContextInterceptor(dataSource);
    const next = nextRunning(async () => {
      const ctx = tenantStorage.getStore();
      const rows = (await ctx!.entityManager!.query(
        `SELECT kindergarten_id FROM refresh_tokens WHERE kindergarten_id IN ($1, $2)`,
        [kgA, kgB],
      )) as Array<{ kindergarten_id: string }>;
      return rows;
    });
    const result = (await lastValueFrom(
      interceptor.intercept(
        makeCtx({ tenant: { kgId: null, bypass: true } }),
        next,
      ),
    )) as Array<{ kindergarten_id: string }>;
    const seen = new Set(result.map((r) => r.kindergarten_id));
    expect(seen.has(kgA)).toBe(true);
    expect(seen.has(kgB)).toBe(true);
  });

  it('without GUCs (raw transaction, no interceptor) RLS hides every row', async () => {
    const visible = await dataSource.transaction(async (m) => {
      // Explicitly do NOT issue SET LOCAL — just plain SELECT inside a tx.
      const rows = (await m.query(
        `SELECT 1 FROM refresh_tokens WHERE kindergarten_id IN ($1, $2)`,
        [kgA, kgB],
      )) as unknown[];
      return rows;
    });
    expect(visible).toHaveLength(0);
  });

  it('rejects non-UUID kindergarten id (defense-in-depth)', async () => {
    const interceptor = new TenantContextInterceptor(dataSource);
    const next = nextRunning(() => Promise.resolve('unreachable'));
    await expect(
      firstValueFrom(
        interceptor.intercept(
          makeCtx({ tenant: { kgId: "'; DROP TABLE", bypass: false } }),
          next,
        ),
      ),
    ).rejects.toThrow(/invalid_kindergarten_id/);
  });
});
