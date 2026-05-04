/**
 * Concurrent meal copy-week race.
 *
 * Self-skips when `INTEGRATION_DB !== '1'` so `npm test` stays green on
 * machines without a configured tenant DB. Run with:
 *
 *   INTEGRATION_DB=1 DATABASE_USERNAME=shyraq_app DATABASE_PASSWORD=shyraq_app \
 *   npm test -- --testPathPattern meal-copy-week.race.integration
 *
 * What this guards: MealService.copyWeekMenuToNext does
 *   1. existsAnyInRange(target_week)   ← boolean probe
 *   2. if false → batchCreate(...)
 *
 * Two concurrent callers (cron + admin manual click, two admin clicks) can
 * both pass step 1 in the race window, both enter batchCreate, the loser's
 * INSERT hits 23505 → PG sets TX state to 25P02 → every subsequent statement
 * raises InFailedSqlTransactionError, propagating as a 500.
 *
 * Fix: MealPlanRepository.acquireWeekCopyLock(kg, weekStart) calls
 *   pg_advisory_xact_lock(hashtext('meal-copy:'||kg||':'||weekStart)::bigint)
 * before existsAnyInRange. Concurrent callers serialize on the lock, the
 * second one observes the first one's just-committed plans and short-circuits
 * to plans_skipped = sourceCount.
 *
 * The spec verifies the primitive directly: with the lock + probe in place,
 * 2 concurrent acquireWeekCopyLock + existsAnyInRange + (conditional)
 * batchCreate sequences produce exactly 1 winner (creates rows) and 1 loser
 * (probe sees the just-created rows and short-circuits).
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { MealPlan } from '@/modules/meal/domain/entities/meal-plan.entity';
import { MealItemEntity } from '@/modules/meal/infrastructure/persistence/relational/entities/meal-item.entity';
import { MealPlanEntity } from '@/modules/meal/infrastructure/persistence/relational/entities/meal-plan.entity';
import { MealPlanRelationalRepository } from '@/modules/meal/infrastructure/persistence/relational/repositories/meal-plan-relational.repository';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

describeIntegration(
  'MealPlanRepository.acquireWeekCopyLock — concurrent copyWeekMenuToNext race',
  () => {
    jest.setTimeout(60_000);

    let dataSource: DataSource;
    let kgId: string;
    const sourceMonday = '2026-04-27'; // Monday
    const targetMonday = '2026-05-04'; // following Monday
    const targetSunday = '2026-05-10';

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
        entities: [MealPlanEntity, MealItemEntity],
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
      const slug = `meal-race-${kgId.slice(0, 8)}`;

      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(
          `INSERT INTO kindergartens (id, name, slug, is_active)
           VALUES ($1, 'Meal Race KG', $2, true)`,
          [kgId, slug],
        );
        // Seed 3 source-week plans (Mon, Wed, Fri) — kg-wide (group_id NULL).
        for (const dateStr of ['2026-04-27', '2026-04-29', '2026-05-01']) {
          await m.query(
            `INSERT INTO meal_plans
               (id, kindergarten_id, date, group_id, is_published, source)
             VALUES ($1, $2, $3, NULL, false, 'manual')`,
            [randomUUID(), kgId, dateStr],
          );
        }
      });
    });

    afterEach(async () => {
      if (!dataSource?.isInitialized) return;
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(
          `DELETE FROM meal_items mi USING meal_plans mp
                       WHERE mi.meal_plan_id = mp.id AND mp.kindergarten_id = $1`,
          [kgId],
        );
        await m.query(`DELETE FROM meal_plans WHERE kindergarten_id = $1`, [
          kgId,
        ]);
        await m.query(`DELETE FROM kindergartens WHERE id = $1`, [kgId]);
      });
    });

    async function runInTenantTx<T>(fn: () => Promise<T>): Promise<T> {
      return dataSource.transaction(async (manager) => {
        await manager.query(`SET LOCAL app.kindergarten_id = '${kgId}'`);
        return tenantStorage.run(
          { kgId, bypass: false, entityManager: manager },
          fn,
        );
      });
    }

    /**
     * Mirrors MealService.copyWeekMenuToNext's structure: lock, probe,
     * batchCreate-or-skip. Returns whether THIS caller materialized rows
     * (winner) or short-circuited on the probe (loser).
     */
    async function tryCopy(
      repo: MealPlanRelationalRepository,
    ): Promise<{ kind: 'winner'; created: number } | { kind: 'loser' }> {
      await repo.acquireWeekCopyLock(kgId, targetMonday);
      const sourcePlans = await repo.list(kgId, {
        dateFrom: sourceMonday,
        dateTo: '2026-05-03',
      });
      const exists = await repo.existsAnyInRange(
        kgId,
        targetMonday,
        targetSunday,
      );
      if (exists) {
        return { kind: 'loser' };
      }
      const newPlans: MealPlan[] = sourcePlans.map((src) => {
        // shift by 7 UTC days
        const next = new Date(`${src.date}T00:00:00Z`);
        next.setUTCDate(next.getUTCDate() + 7);
        const targetDateStr = next.toISOString().slice(0, 10);
        return MealPlan.create({
          id: randomUUID(),
          kindergartenId: kgId,
          date: targetDateStr,
          groupId: src.groupId,
          isPublished: src.isPublished,
          notes: src.notes,
          source: 'copied',
          copiedFrom: src.id,
          createdBy: src.createdBy,
          now: new Date(),
          items: [],
        });
      });
      const result = await repo.batchCreate(kgId, newPlans);
      return { kind: 'winner', created: result.plans_created };
    }

    it('serializes 2 concurrent copyWeekMenuToNext sequences — exactly 1 winner + 1 loser, no 23505 poisoning', async () => {
      const repo = new MealPlanRelationalRepository(
        dataSource.getRepository(MealPlanEntity),
        dataSource.getRepository(MealItemEntity),
      );

      const results = await Promise.all([
        runInTenantTx(() => tryCopy(repo)),
        runInTenantTx(() => tryCopy(repo)),
      ]);

      const winners = results.filter((r) => r.kind === 'winner');
      const losers = results.filter((r) => r.kind === 'loser');
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect((winners[0] as { created: number }).created).toBe(3);

      // DB invariant: exactly 3 target-week plans.
      const rows = (await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        return m.query(
          `SELECT COUNT(*)::int AS cnt FROM meal_plans
           WHERE kindergarten_id = $1 AND date >= $2 AND date <= $3`,
          [kgId, targetMonday, targetSunday],
        );
      })) as Array<{ cnt: number }>;
      expect(rows[0].cnt).toBe(3);
    });
  },
);
