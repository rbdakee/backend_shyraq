/**
 * B10 Identity QR — concurrent issueOrRefresh integration spec.
 *
 * Self-skips when `INTEGRATION_DB !== '1'` so `npm test` stays green on
 * machines without a configured tenant DB. Run with
 *   `INTEGRATION_DB=1 DATABASE_USERNAME=shyraq_app DATABASE_PASSWORD=shyraq_app \
 *    npm test -- --testPathPattern identity-qr.race.integration-spec`
 *
 * What this guards: T6 review found a 23505 race when two simultaneous
 * `GET /users/me/qr` calls for the same user both observed "no active row",
 * both ran revoke-all (no-op), then raced on INSERT. The partial unique
 * idx `(user_id, purpose) WHERE revoked_at IS NULL` rejected the second,
 * surfacing as a 500. The fix is `pg_advisory_xact_lock` keyed on the
 * user-id at the start of `issueOrRefresh`; the second concurrent call
 * blocks until the first commits, then re-runs cleanly.
 *
 * The spec runs three concurrent `service.issueOrRefresh(userId)` calls
 * inside the same TenantContextInterceptor wiring the HTTP path uses, and
 * asserts:
 *   - All three resolve (no thrown error / 500).
 *   - Final DB state has exactly 1 active row + 2 revoked rows for that
 *     user, all with valid 64-hex token_hash.
 *   - No 23505 leaks through.
 */
import 'reflect-metadata';
import { ExecutionContext } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { defer, lastValueFrom } from 'rxjs';
import { DataSource } from 'typeorm';
import { TenantContextInterceptor } from '@/common/interceptors/tenant-context.interceptor';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { ChildGuardianRepository } from '@/modules/child/infrastructure/persistence/child-guardian.repository';
import { ChildRepository } from '@/modules/child/infrastructure/persistence/child.repository';
import { RefreshTokenRepository } from '@/modules/auth/infrastructure/persistence/refresh-token.repository';
import { StaffMemberRepository } from '@/modules/staff/infrastructure/persistence/staff-member.repository';
import { UserRepository } from '@/modules/users/infrastructure/persistence/user.repository';
import { IdentityQrService } from './identity-qr.service';
import { QrTokenCachePort } from './infrastructure/cache/qr-token-cache.port';
import { QrScanRateLimiterPort } from './infrastructure/rate-limit/qr-scan-rate-limiter.port';
import { UserQrTokenTypeOrmEntity } from './infrastructure/persistence/relational/entities/user-qr-token.typeorm.entity';
import { IdentityQrRelationalRepository } from './infrastructure/persistence/relational/repositories/identity-qr.relational.repository';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

class FakeQrTokenCache extends QrTokenCachePort {
  async setToken(): Promise<void> {
    // No-op: race-test is purely about the DB partial-unique invariant.
  }
  lookup(): Promise<string | null> {
    return Promise.resolve(null);
  }
  async revoke(): Promise<void> {
    // No-op.
  }
}

class FakeRateLimiter extends QrScanRateLimiterPort {
  check(): Promise<{ ok: boolean; retryAfterSeconds: number | null }> {
    return Promise.resolve({ ok: true, retryAfterSeconds: null });
  }
}

class FixedClock implements ClockPort {
  constructor(private readonly d: Date) {}
  now(): Date {
    return this.d;
  }
}

describeIntegration('IdentityQrService — concurrent issueOrRefresh', () => {
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
      username: process.env.DATABASE_USERNAME ?? 'shyraq_app',
      password: process.env.DATABASE_PASSWORD ?? 'shyraq_app',
      database: process.env.DATABASE_NAME ?? 'shyraq',
      entities: [UserQrTokenTypeOrmEntity],
      synchronize: false,
      logging: false,
      // Enough connections so the three concurrent issueOrRefresh calls can
      // each open their own TX without queue-stalling on the pool.
      poolSize: 10,
    });
    await dataSource.initialize();
  });

  afterAll(async () => {
    if (!dataSource?.isInitialized) return;
    await dataSource.destroy();
  });

  beforeEach(async () => {
    userId = randomUUID();
    // Seed a real users row — user_qr_tokens.user_id is FK-constrained.
    // Phone must be unique; we derive it from the synthetic uuid so each
    // case gets its own row.
    const phone = `+7700${userId.slice(0, 7).replace(/[^0-9]/g, '0')}`;
    await dataSource.query(
      `INSERT INTO users (id, phone, full_name) VALUES ($1, $2, 'race-test')`,
      [userId, phone],
    );
  });

  afterEach(async () => {
    if (!dataSource?.isInitialized) return;
    await dataSource.query(`DELETE FROM user_qr_tokens WHERE user_id = $1`, [
      userId,
    ]);
    await dataSource.query(`DELETE FROM users WHERE id = $1`, [userId]);
  });

  function makeCtx(req: Record<string, unknown>): ExecutionContext {
    return {
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
  }

  /**
   * Replicates the HTTP-pipeline's TX wiring: open a transaction, push the
   * EntityManager into `tenantStorage` so the QR repo's `manager()` helper
   * returns it, then run `fn`. The advisory lock the service issues lives
   * inside this same TX, so concurrent invocations serialize properly.
   *
   * `bypass=true` because user_qr_tokens has no RLS — the QR endpoints
   * don't have a kg-scope context but the interceptor still needs *some*
   * setting; bypass mirrors what `@SuperAdminScope()` produces in prod.
   */
  async function runScoped<T>(fn: () => Promise<T>): Promise<T> {
    const interceptor = new TenantContextInterceptor(dataSource);
    const next = { handle: () => defer(async () => fn()) };
    return (await lastValueFrom(
      interceptor.intercept(
        makeCtx({ tenant: { kgId: null, bypass: true } }),
        next,
      ),
    )) as T;
  }

  function makeService(): IdentityQrService {
    const baseRepo = dataSource.getRepository(UserQrTokenTypeOrmEntity);
    const qrRepo = new IdentityQrRelationalRepository(baseRepo);
    const cache = new FakeQrTokenCache();
    const rateLimiter = new FakeRateLimiter();
    const clock = new FixedClock(new Date('2026-05-02T12:00:00Z'));
    return new IdentityQrService(
      qrRepo,
      cache,
      rateLimiter,
      clock,
      // The race spec only exercises issueOrRefresh; downstream deps are
      // not invoked. Cast through unknown to satisfy the constructor
      // signature without fabricating fakes that would never be called.
      null as unknown as RefreshTokenRepository,
      null as unknown as ChildGuardianRepository,
      null as unknown as ChildRepository,
      null as unknown as StaffMemberRepository,
      null as unknown as UserRepository,
    );
  }

  it('three concurrent issueOrRefresh calls all succeed; final state = 1 active + 2 revoked', async () => {
    const service = makeService();

    // Three parallel HTTP-equivalents. Each opens its own TX via
    // TenantContextInterceptor; they race for the advisory lock.
    const results = await Promise.all([
      runScoped(() => service.issueOrRefresh(userId)),
      runScoped(() => service.issueOrRefresh(userId)),
      runScoped(() => service.issueOrRefresh(userId)),
    ]);

    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.token).toMatch(/^[0-9a-f]{32}$/);
      expect(r.expiresAt.getTime()).toBeGreaterThan(r.issuedAt.getTime());
    }

    const rows = (await dataSource.query(
      `SELECT id, token_hash, revoked_at FROM user_qr_tokens WHERE user_id = $1`,
      [userId],
    )) as Array<{
      id: string;
      token_hash: string;
      revoked_at: string | null;
    }>;

    expect(rows).toHaveLength(3);
    const active = rows.filter((r) => r.revoked_at === null);
    const revoked = rows.filter((r) => r.revoked_at !== null);
    expect(active).toHaveLength(1);
    expect(revoked).toHaveLength(2);
    for (const r of rows) {
      expect(r.token_hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
