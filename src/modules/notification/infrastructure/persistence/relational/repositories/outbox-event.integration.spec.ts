/**
 * B9 outbox repository — integration spec.
 *
 * Self-skips when `INTEGRATION_DB !== '1'` so `npm test` stays green on
 * machines without a configured tenant DB. Run with
 *   `INTEGRATION_DB=1 npm test -- --testPathPattern outbox-event.integration`
 *
 * Coverage:
 *   1. enqueue + findById round-trip under tenant scope.
 *   2. RLS phantom isolation: kg_A enqueue, kg_B cannot see; bypass sees both.
 *   3. claimBatch race condition: two concurrent transactions claim 5 pending
 *      rows with FOR UPDATE SKIP LOCKED — total claimed across both = 5,
 *      no double-claim.
 *   4. next_retry_at filter: future row not claimed; advancing now picks it up.
 *   5. markFailedWithRetry until terminal: 5 calls drive the row to failed.
 */
import 'reflect-metadata';
import { defer, lastValueFrom } from 'rxjs';
import { DataSource } from 'typeorm';
import { ExecutionContext } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { TenantContextInterceptor } from '@/common/interceptors/tenant-context.interceptor';
import { tenantStorage } from '@/database/tenant-storage';
import { CameraEntity } from '@/modules/camera/infrastructure/persistence/relational/entities/camera.entity';
import { ChildEntity } from '@/modules/child/infrastructure/persistence/relational/entities/child.entity';
import { ChildGroupHistoryEntity } from '@/modules/child/infrastructure/persistence/relational/entities/child-group-history.entity';
import { ChildGuardianEntity } from '@/modules/child/infrastructure/persistence/relational/entities/child-guardian.entity';
import { GroupEntity } from '@/modules/group/infrastructure/persistence/relational/entities/group.entity';
import { GroupMentorEntity } from '@/modules/group/infrastructure/persistence/relational/entities/group-mentor.entity';
import { KindergartenEntity } from '@/modules/kindergarten/infrastructure/persistence/relational/entities/kindergarten.entity';
import { LocationEntity } from '@/modules/location/infrastructure/persistence/relational/entities/location.entity';
import { StaffMemberEntity } from '@/modules/staff/infrastructure/persistence/relational/entities/staff-member.entity';
import { UserEntity } from '@/modules/users/infrastructure/persistence/relational/entities/user.entity';
import {
  defaultBackoff,
  MAX_OUTBOX_ATTEMPTS,
  OutboxEvent,
} from '../../../../domain/entities/outbox-event.entity';
import { OutboxEventTypeOrmEntity } from '../entities/outbox-event.typeorm-entity';
import { OutboxEventRelationalRepository } from './outbox-event.relational-repository';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

describeIntegration('OutboxEventRelationalRepository — integration', () => {
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
      entities: [
        KindergartenEntity,
        UserEntity,
        StaffMemberEntity,
        LocationEntity,
        GroupEntity,
        GroupMentorEntity,
        CameraEntity,
        ChildEntity,
        ChildGuardianEntity,
        ChildGroupHistoryEntity,
        OutboxEventTypeOrmEntity,
      ],
      synchronize: false,
      logging: false,
      // Enough connections for the concurrent-claim race scenario (2 sibling
      // transactions + the housekeeping queries the test driver issues).
      poolSize: 10,
    });
    await dataSource.initialize();

    await dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      kgA = randomUUID();
      kgB = randomUUID();
      await m.insert(KindergartenEntity, [
        { id: kgA, name: 'KG-A', slug: `kg-a-outbox-${kgA}` },
        { id: kgB, name: 'KG-B', slug: `kg-b-outbox-${kgB}` },
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

  // Wipe outbox between cases so each test starts with a clean slate.
  beforeEach(async () => {
    await dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      await m.query(
        `DELETE FROM notification_outbox WHERE kindergarten_id IN ($1, $2)`,
        [kgA, kgB],
      );
    });
  });

  function makeCtx(req: Record<string, unknown>): ExecutionContext {
    return {
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
  }

  /**
   * Run `fn` inside the same RLS-scoped transaction the
   * `TenantContextInterceptor` would set up — `SET LOCAL app.kindergarten_id`
   * (or `app.bypass_rls`) applied and the EntityManager pushed into
   * `tenantStorage` so the relational repo's `manager()` picks it up.
   */
  async function runScoped<T>(
    tenant: { kgId: string | null; bypass: boolean },
    fn: () => Promise<T>,
  ): Promise<T> {
    const interceptor = new TenantContextInterceptor(dataSource);
    const next = { handle: () => defer(async () => fn()) };
    return (await lastValueFrom(
      interceptor.intercept(makeCtx({ tenant }), next),
    )) as T;
  }

  function makeRepo(): OutboxEventRelationalRepository {
    const baseRepo = dataSource.getRepository(OutboxEventTypeOrmEntity);
    return new OutboxEventRelationalRepository(baseRepo);
  }

  // ── 1. enqueue + findById round-trip ───────────────────────────────────────

  it('enqueue persists a pending row and findById returns it', async () => {
    const repo = makeRepo();
    const created = await runScoped(
      { kgId: kgA, bypass: false },
      async () =>
        await repo.enqueue({
          kindergartenId: kgA,
          eventKey: 'attendance.checkin',
          payload: { childId: 'child-1' },
        }),
    );

    expect(created.id).toBeDefined();
    expect(created.status.value).toBe('pending');
    expect(created.attempts).toBe(0);
    expect(created.kindergartenId).toBe(kgA);

    const found = await runScoped(
      { kgId: kgA, bypass: false },
      async () => await repo.findById(created.id!),
    );
    expect(found).not.toBeNull();
    expect(found!.eventKey).toBe('attendance.checkin');
    expect(found!.payload).toEqual({ childId: 'child-1' });
  });

  // ── 2. RLS phantom isolation ───────────────────────────────────────────────

  it('RLS hides rows from other tenants and bypass sees both', async () => {
    const repo = makeRepo();
    const aRow = await runScoped(
      { kgId: kgA, bypass: false },
      async () =>
        await repo.enqueue({
          kindergartenId: kgA,
          eventKey: 'attendance.checkin',
          payload: { tag: 'A' },
        }),
    );
    const bRow = await runScoped(
      { kgId: kgB, bypass: false },
      async () =>
        await repo.enqueue({
          kindergartenId: kgB,
          eventKey: 'attendance.checkin',
          payload: { tag: 'B' },
        }),
    );

    // KG-A scope cannot see KG-B's row.
    const phantom = await runScoped(
      { kgId: kgA, bypass: false },
      async () => await repo.findById(bRow.id!),
    );
    expect(phantom).toBeNull();

    // KG-B scope cannot see KG-A's row.
    const phantom2 = await runScoped(
      { kgId: kgB, bypass: false },
      async () => await repo.findById(aRow.id!),
    );
    expect(phantom2).toBeNull();

    // Bypass scope sees both.
    const both = await runScoped({ kgId: null, bypass: true }, async () => ({
      a: await repo.findById(aRow.id!),
      b: await repo.findById(bRow.id!),
    }));
    expect(both.a).not.toBeNull();
    expect(both.b).not.toBeNull();
  });

  // ── 3. claimBatch race condition ───────────────────────────────────────────

  it('claimBatch with FOR UPDATE SKIP LOCKED prevents concurrent double-claim', async () => {
    const repo = makeRepo();

    // Seed 5 pending rows under bypass scope (worker semantics).
    const seeded: string[] = [];
    await runScoped({ kgId: null, bypass: true }, async () => {
      for (let i = 0; i < 5; i++) {
        const ev = await repo.enqueue({
          kindergartenId: i % 2 === 0 ? kgA : kgB,
          eventKey: 'attendance.checkin',
          payload: { i },
        });
        seeded.push(ev.id!);
      }
    });

    // Two concurrent transactions both call claimBatch(limit=3). With
    // FOR UPDATE SKIP LOCKED, neither blocks; their result sets must be
    // disjoint. We force overlap by managing the transactions via
    // `createQueryRunner()` so we can BEGIN both before either SELECT
    // commits — that guarantees the two locks coexist long enough for
    // SKIP LOCKED semantics to engage.
    //
    // limit=3 forces both transactions to claim something (the first cannot
    // grab all 5; the second has to pick up the remaining 2 the first
    // skipped).
    const now = new Date();
    const runnerA = dataSource.createQueryRunner();
    const runnerB = dataSource.createQueryRunner();
    let aIds: string[] = [];
    let bIds: string[] = [];
    try {
      await runnerA.connect();
      await runnerB.connect();
      await runnerA.startTransaction();
      await runnerB.startTransaction();
      await runnerA.query(`SET LOCAL app.bypass_rls = 'true'`);
      await runnerB.query(`SET LOCAL app.bypass_rls = 'true'`);

      // Both transactions are now live on distinct connections. Issue
      // claimBatch sequentially on the JS event loop — the second SELECT
      // observes the locks taken by the first and uses SKIP LOCKED to
      // step over them, so it gets a disjoint subset of the remaining
      // pending rows rather than blocking or returning the same rows.
      const claimedA = await repo.claimBatch(runnerA.manager, 3, now);
      const claimedB = await repo.claimBatch(runnerB.manager, 3, now);
      aIds = claimedA.map((c) => c.id!);
      bIds = claimedB.map((c) => c.id!);

      await runnerA.commitTransaction();
      await runnerB.commitTransaction();
    } finally {
      await runnerA.release();
      await runnerB.release();
    }

    // No double-claim: intersection must be empty.
    const intersection = aIds.filter((id) => bIds.includes(id));
    expect(intersection).toEqual([]);

    // Each transaction picked up its own non-empty disjoint subset.
    expect(aIds.length).toBe(3);
    expect(bIds.length).toBe(2); // the 2 remaining after A's lock
    // Union covers every seeded row.
    const union = new Set<string>([...aIds, ...bIds]);
    expect(union.size).toBe(5);
    for (const id of seeded) expect(union.has(id)).toBe(true);
  });

  // ── 4. next_retry_at filter ────────────────────────────────────────────────

  it('claimBatch respects next_retry_at — future rows are skipped', async () => {
    const repo = makeRepo();
    const future = new Date(Date.now() + 60 * 60_000); // +1h

    // Seed one pending row whose next_retry_at is 1h in the future. The
    // bump must run inside the same bypass-RLS transaction that wrote the
    // row — a fresh `dataSource.query` would land on a pool connection
    // without the GUC and the RLS policy would silently filter the UPDATE
    // out (zero rows affected). We use `runScoped` so the manager from
    // tenantStorage carries the GUC into the raw UPDATE.
    const seededId = await runScoped({ kgId: null, bypass: true }, async () => {
      const ev = await repo.enqueue({
        kindergartenId: kgA,
        eventKey: 'attendance.checkin',
        payload: {},
      });
      const m = tenantStorage.getStore()!.entityManager!;
      await m.query(
        `UPDATE notification_outbox SET next_retry_at = $1 WHERE id = $2`,
        [future, ev.id],
      );
      return ev.id!;
    });

    // claim with now=present → row should NOT come back.
    const claimedNow = await dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      return await repo.claimBatch(m, 10, new Date());
    });
    expect(claimedNow.find((e) => e.id === seededId)).toBeUndefined();

    // claim with now=future+1s → row should now come back.
    const claimedFuture = await dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      return await repo.claimBatch(m, 10, new Date(future.getTime() + 1000));
    });
    expect(claimedFuture.find((e) => e.id === seededId)).toBeDefined();
  });

  // ── 5. markFailedWithRetry retries until terminal ──────────────────────────

  it('markFailedWithRetry drives a row to terminal failed after MAX attempts', async () => {
    const repo = makeRepo();

    const seededId = await runScoped({ kgId: null, bypass: true }, async () => {
      const ev = await repo.enqueue({
        kindergartenId: kgA,
        eventKey: 'attendance.checkin',
        payload: {},
      });
      return ev.id!;
    });

    // Replay the dispatcher → domain → repo flow MAX_OUTBOX_ATTEMPTS times.
    for (let i = 0; i < MAX_OUTBOX_ATTEMPTS; i++) {
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        const claimed = await repo.claimBatch(
          m,
          10,
          new Date(Date.now() + 86_400_000),
        );
        const target = claimed.find((c) => c.id === seededId);
        expect(target).toBeDefined();
        const now = new Date();
        target!.markFailed(now, `attempt-${i + 1}`, defaultBackoff);
        await repo.markFailedWithRetry(
          m,
          target!.id!,
          now,
          target!.failedReason!,
          target!.attempts,
          target!.nextRetryAt,
          target!.isTerminal(),
        );
      });
    }

    const final: OutboxEvent | null = await runScoped(
      { kgId: null, bypass: true },
      async () => await repo.findById(seededId),
    );
    expect(final).not.toBeNull();
    expect(final!.status.value).toBe('failed');
    expect(final!.attempts).toBe(MAX_OUTBOX_ATTEMPTS);
  });

  // ── 6. markDispatched terminal transition ──────────────────────────────────

  it('markDispatched flips status to dispatched and stamps dispatched_at', async () => {
    const repo = makeRepo();

    const seededId = await runScoped({ kgId: kgA, bypass: false }, async () => {
      const ev = await repo.enqueue({
        kindergartenId: kgA,
        eventKey: 'attendance.checkin',
        payload: {},
      });
      return ev.id!;
    });

    await dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      const claimed = await repo.claimBatch(m, 10, new Date());
      const target = claimed.find((c) => c.id === seededId);
      expect(target).toBeDefined();
      await repo.markDispatched(m, target!.id!, new Date());
    });

    const after = await runScoped(
      { kgId: kgA, bypass: false },
      async () => await repo.findById(seededId),
    );
    expect(after).not.toBeNull();
    expect(after!.status.value).toBe('dispatched');
    expect(after!.dispatchedAt).not.toBeNull();
  });
});
