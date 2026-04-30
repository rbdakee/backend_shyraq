/**
 * MealPlan — cross-tenant phantom-row isolation + partial-unique index tests.
 *
 * Gated: set INTEGRATION_DB=1 with a running PG instance (docker compose).
 * Mirrors the pattern used in enrollment.repository.integration.spec.ts.
 *
 * Tests:
 *   1. Cross-tenant: KG-A scope can see only KG-A plans.
 *   2. Cross-tenant: KG-B scope cannot see KG-A plans.
 *   3. Partial unique index (group_id NOT NULL): duplicate (kg, group, date) → 409.
 *   4. Partial unique index (group_id IS NULL): duplicate (kg, NULL, date) → 409.
 *   5. Different date for kg-wide plan succeeds.
 *   6. WITH CHECK: insert with kgB-id under kgA GUC → 42501/23514.
 *   7. copyWeekMenuToNext idempotency via real PG.
 */
import 'reflect-metadata';
import { defer, lastValueFrom } from 'rxjs';
import { DataSource, QueryFailedError } from 'typeorm';
import { ExecutionContext } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { TenantContextInterceptor } from '@/common/interceptors/tenant-context.interceptor';
import { ChildEntity } from '@/modules/child/infrastructure/persistence/relational/entities/child.entity';
import { ChildGroupHistoryEntity } from '@/modules/child/infrastructure/persistence/relational/entities/child-group-history.entity';
import { ChildGuardianEntity } from '@/modules/child/infrastructure/persistence/relational/entities/child-guardian.entity';
import { CameraEntity } from '@/modules/camera/infrastructure/persistence/relational/entities/camera.entity';
import { GroupEntity } from '@/modules/group/infrastructure/persistence/relational/entities/group.entity';
import { GroupMentorEntity } from '@/modules/group/infrastructure/persistence/relational/entities/group-mentor.entity';
import { KindergartenEntity } from '@/modules/kindergarten/infrastructure/persistence/relational/entities/kindergarten.entity';
import { LocationEntity } from '@/modules/location/infrastructure/persistence/relational/entities/location.entity';
import { StaffMemberEntity } from '@/modules/staff/infrastructure/persistence/relational/entities/staff-member.entity';
import { UserEntity } from '@/modules/users/infrastructure/persistence/relational/entities/user.entity';
import { MealPlan } from '../../../../domain/entities/meal-plan.entity';
import { MealPlanAlreadyExistsError } from '../../../../domain/errors/meal-plan-already-exists.error';
import { MealItemEntity } from '../entities/meal-item.entity';
import { MealPlanEntity } from '../entities/meal-plan.entity';
import { MealPlanRelationalRepository } from './meal-plan-relational.repository';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

interface PgError {
  code?: string;
}

describeIntegration('MealPlanRelationalRepository — integration', () => {
  jest.setTimeout(60_000);

  let dataSource: DataSource;
  let kgA: string;
  let kgB: string;
  let groupA: string;

  const fixedClock = new Date('2026-05-01T10:00:00.000Z');

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
        MealPlanEntity,
        MealItemEntity,
      ],
      synchronize: false,
      logging: false,
    });
    await dataSource.initialize();

    await dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      kgA = randomUUID();
      kgB = randomUUID();
      groupA = randomUUID();

      await m.insert(KindergartenEntity, [
        { id: kgA, name: 'KG-A-Meal', slug: `kg-a-meal-${kgA.slice(0, 8)}` },
        { id: kgB, name: 'KG-B-Meal', slug: `kg-b-meal-${kgB.slice(0, 8)}` },
      ]);
      // Insert a group for kgA
      await m.query(
        `INSERT INTO groups (id, kindergarten_id, name, capacity, created_at, updated_at)
         VALUES ($1, $2, 'Group-A', 20, now(), now())`,
        [groupA, kgA],
      );
    });
  });

  afterAll(async () => {
    if (!dataSource?.isInitialized) return;
    await dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      await m.query(
        `DELETE FROM meal_items WHERE meal_plan_id IN (SELECT id FROM meal_plans WHERE kindergarten_id IN ($1, $2))`,
        [kgA, kgB],
      );
      await m.query(
        `DELETE FROM meal_plans WHERE kindergarten_id IN ($1, $2)`,
        [kgA, kgB],
      );
      await m.query(`DELETE FROM groups WHERE kindergarten_id IN ($1, $2)`, [
        kgA,
        kgB,
      ]);
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

  function makeRepo(): MealPlanRelationalRepository {
    const baseRepo = dataSource.getRepository(MealPlanEntity);
    const itemRepo = dataSource.getRepository(MealItemEntity);
    return new MealPlanRelationalRepository(baseRepo, itemRepo);
  }

  function makePlan(
    kgId: string,
    date: string,
    groupId: string | null = null,
  ): MealPlan {
    return MealPlan.create({
      id: randomUUID(),
      kindergartenId: kgId,
      date,
      groupId,
      isPublished: true,
      now: fixedClock,
    });
  }

  // ── 1. Cross-tenant isolation ────────────────────────────────────────────

  it('findById: KG-A scope returns only KG-A plan', async () => {
    const repo = makeRepo();
    const plan = makePlan(kgA, '2026-05-02');

    await runScoped({ kgId: kgA, bypass: false }, async () => {
      await repo.create(kgA, plan);
    });

    const found = await runScoped(
      { kgId: kgA, bypass: false },
      async () => await repo.findById(kgA, plan.id),
    );
    expect(found).not.toBeNull();
    expect(found!.id).toBe(plan.id);
  });

  it('findById: KG-B scope cannot see KG-A plan', async () => {
    const repo = makeRepo();
    const plan = makePlan(kgA, '2026-05-03');

    await runScoped({ kgId: kgA, bypass: false }, async () => {
      await repo.create(kgA, plan);
    });

    const found = await runScoped(
      { kgId: kgB, bypass: false },
      async () => await repo.findById(kgB, plan.id),
    );
    expect(found).toBeNull();
  });

  it('list: KG-A scope returns only KG-A plans', async () => {
    const repo = makeRepo();
    const planA = makePlan(kgA, '2026-05-04');
    const planB = makePlan(kgB, '2026-05-04');

    await runScoped({ kgId: kgA, bypass: false }, async () => {
      await repo.create(kgA, planA);
    });
    await runScoped({ kgId: kgB, bypass: false }, async () => {
      await repo.create(kgB, planB);
    });

    const results = await runScoped(
      { kgId: kgA, bypass: false },
      async () =>
        await repo.list(kgA, { dateFrom: '2026-05-04', dateTo: '2026-05-04' }),
    );
    const ids = results.map((p) => p.id);
    expect(ids).toContain(planA.id);
    expect(ids).not.toContain(planB.id);
  });

  // ── 2. Partial-unique indexes ────────────────────────────────────────────

  it('partial-unique (group_id NOT NULL): duplicate (kg, group, date) → MealPlanAlreadyExistsError', async () => {
    const repo = makeRepo();
    const date = '2026-05-05';
    const plan1 = makePlan(kgA, date, groupA);
    const plan2 = makePlan(kgA, date, groupA);

    await runScoped({ kgId: kgA, bypass: false }, async () => {
      await repo.create(kgA, plan1);
    });

    let caught: unknown = null;
    try {
      await runScoped({ kgId: kgA, bypass: false }, async () => {
        await repo.create(kgA, plan2);
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MealPlanAlreadyExistsError);
  });

  it('partial-unique (group_id IS NULL): duplicate (kg, NULL, date) → MealPlanAlreadyExistsError', async () => {
    const repo = makeRepo();
    const date = '2026-05-06';
    const plan1 = makePlan(kgA, date, null);
    const plan2 = makePlan(kgA, date, null);

    await runScoped({ kgId: kgA, bypass: false }, async () => {
      await repo.create(kgA, plan1);
    });

    let caught: unknown = null;
    try {
      await runScoped({ kgId: kgA, bypass: false }, async () => {
        await repo.create(kgA, plan2);
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MealPlanAlreadyExistsError);
  });

  it('partial-unique (group_id IS NULL): different date is OK', async () => {
    const repo = makeRepo();
    const plan1 = makePlan(kgA, '2026-05-07', null);
    const plan2 = makePlan(kgA, '2026-05-08', null);

    await runScoped({ kgId: kgA, bypass: false }, async () => {
      await repo.create(kgA, plan1);
      await repo.create(kgA, plan2);
    });
    // No error means success
    const results = await runScoped(
      { kgId: kgA, bypass: false },
      async () =>
        await repo.list(kgA, { dateFrom: '2026-05-07', dateTo: '2026-05-08' }),
    );
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  // ── 3. RLS WITH CHECK ────────────────────────────────────────────────────

  it('WITH CHECK: insert with kgB-id under kgA GUC is rejected', async () => {
    const repo = makeRepo();
    const crossPlan = makePlan(kgB, '2026-05-09');

    let caught: unknown = null;
    try {
      await runScoped({ kgId: kgA, bypass: false }, async () => {
        await repo.create(kgB, crossPlan);
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(QueryFailedError);
    const pg = (caught as QueryFailedError).driverError as PgError;
    expect(['42501', '23514']).toContain(pg.code);
  });

  // ── 4. copyWeekMenuToNext idempotency ────────────────────────────────────

  it('batchCreate is idempotent: second call skips existing plans', async () => {
    const repo = makeRepo();
    const plan = makePlan(kgA, '2026-05-12');

    // First insert
    const r1 = await runScoped(
      { kgId: kgA, bypass: false },
      async () => await repo.batchCreate(kgA, [plan]),
    );
    expect(r1.plans_created).toBe(1);
    expect(r1.plans_skipped).toBe(0);

    // Duplicate plan — same id would fail PK, use same date+group
    const dup = makePlan(kgA, '2026-05-12', null);
    const r2 = await runScoped(
      { kgId: kgA, bypass: false },
      async () => await repo.batchCreate(kgA, [dup]),
    );
    expect(r2.plans_created).toBe(0);
    expect(r2.plans_skipped).toBe(1);
  });

  // ── 5. bypass=true shows all tenants ────────────────────────────────────

  it('bypass=true exposes plans from multiple tenants', async () => {
    const repo = makeRepo();
    const planA = makePlan(kgA, '2026-05-15');
    const planB = makePlan(kgB, '2026-05-15');

    await runScoped({ kgId: kgA, bypass: false }, async () => {
      await repo.create(kgA, planA);
    });
    await runScoped({ kgId: kgB, bypass: false }, async () => {
      await repo.create(kgB, planB);
    });

    const result = await runScoped({ kgId: null, bypass: true }, async () => {
      const a = await repo.findById(kgA, planA.id);
      const b = await repo.findById(kgB, planB.id);
      return { a, b };
    });
    expect(result.a).not.toBeNull();
    expect(result.b).not.toBeNull();
  });
});
