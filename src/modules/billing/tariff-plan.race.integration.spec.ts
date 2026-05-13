/**
 * B22b T15 Codex H2 — concurrent TariffPlanService.create race spec.
 *
 * Self-skips when `INTEGRATION_DB !== '1'`. Run with:
 *
 *   $env:DATABASE_PORT='55432'; $env:DATABASE_USERNAME='shyraq_app';
 *   $env:DATABASE_PASSWORD='shyraq_app'; $env:INTEGRATION_DB='1';
 *   npm test -- --testPathPatterns='tariff-plan.race'
 *
 * Invariant under test: two concurrent admin `create()` calls for the
 * same `(kg, tariff_type, applies_to, group_id)` scope + overlapping
 * `valid_from..valid_until` windows are serialised by
 * `pg_advisory_xact_lock(hashtext('tariff-overlap:'||kg||':'||type||':'||
 * appliesTo||':'||groupId/null))` acquired BEFORE `existsOverlap()`.
 *
 * Expected outcome: exactly ONE caller persists a row; the second
 * receives `TariffPlanOverlapError` with `code='tariff_plan_overlap'`
 * (HTTP 409 via the standard ConflictError → DomainErrorFilter mapping).
 * The DB ends up with exactly one active row in scope (read-back assert).
 *
 * Pre-T15 (read-before-write) both callers could observe `false` from
 * `existsOverlap()` and both insert, producing two overlapping active
 * plans and nondeterministic `findActiveByType()`.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { TypeOrmTransactionRunnerAdapter } from '@/shared-kernel/infrastructure/adapters/typeorm-transaction-runner.adapter';
import { TariffPlanTypeOrmEntity } from './infrastructure/persistence/relational/entities/tariff-plan.typeorm.entity';
import { TariffPlanRelationalRepository } from './infrastructure/persistence/relational/repositories/tariff-plan.relational.repository';
import { TariffPlanService } from './tariff-plan.service';
import { TariffPlanOverlapError } from './domain/errors/tariff-plan-overlap.error';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

const NOW = new Date('2026-06-15T09:00:00.000Z');

class FixedClock extends ClockPort {
  now(): Date {
    return NOW;
  }
}

describeIntegration(
  'TariffPlanService — concurrent create overlap (advisory lock guard)',
  () => {
    jest.setTimeout(60_000);

    let dataSource: DataSource;

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
        entities: [TariffPlanTypeOrmEntity],
        synchronize: false,
        logging: false,
        poolSize: 20,
      });
      await dataSource.initialize();
    });

    afterAll(async () => {
      if (!dataSource?.isInitialized) return;
      await dataSource.destroy();
    });

    async function seedKg(): Promise<{
      kgId: string;
      cleanup: () => Promise<void>;
    }> {
      const kgId = randomUUID();
      const slug = `tariff-race-${kgId.slice(0, 8)}`;

      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(
          `INSERT INTO kindergartens (id, name, slug) VALUES ($1, 'Tariff Race KG', $2)`,
          [kgId, slug],
        );
      });

      const cleanup = async () => {
        await dataSource.transaction(async (m) => {
          await m.query(`SET LOCAL app.bypass_rls = 'true'`);
          await m.query(`DELETE FROM tariff_plans WHERE kindergarten_id = $1`, [
            kgId,
          ]);
          await m.query(`DELETE FROM kindergartens WHERE id = $1`, [kgId]);
        });
      };

      return { kgId, cleanup };
    }

    function buildService(): TariffPlanService {
      const repo = new TariffPlanRelationalRepository(
        dataSource.getRepository(TariffPlanTypeOrmEntity),
      );
      const tx = new TypeOrmTransactionRunnerAdapter(dataSource);
      return new TariffPlanService(repo, new FixedClock(), tx);
    }

    /** Read-back: count of active tariff_plan rows in the given scope. */
    async function activeRowsForScope(
      kgId: string,
      tariffType: string,
      appliesTo: string,
      groupId: string | null,
    ): Promise<number> {
      return dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        const groupClause =
          groupId === null ? 'AND group_id IS NULL' : 'AND group_id = $4';
        const params: unknown[] = [kgId, tariffType, appliesTo];
        if (groupId !== null) params.push(groupId);
        const rows = (await m.query(
          `SELECT COUNT(*)::int AS c
             FROM tariff_plans
            WHERE kindergarten_id = $1
              AND tariff_type = $2
              AND applies_to = $3
              ${groupClause}
              AND is_active = true`,
          params,
        )) as Array<{ c: number }>;
        return rows[0]?.c ?? 0;
      });
    }

    it('exactly 1 of 2 concurrent creators succeeds for the same scope + overlapping window', async () => {
      const seed = await seedKg();
      const svc = buildService();
      try {
        const input = {
          name: 'Standard',
          tariffType: 'monthly' as const,
          amount: 50_000,
          appliesTo: 'all_children' as const,
          validFrom: new Date('2026-01-01T00:00:00.000Z'),
          validUntil: new Date('2026-12-31T00:00:00.000Z'),
        };
        const results = await Promise.allSettled([
          svc.create(seed.kgId, input),
          svc.create(seed.kgId, input),
        ]);
        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected');
        expect(fulfilled.length).toBe(1);
        expect(rejected.length).toBe(1);
        const err = (rejected[0] as PromiseRejectedResult).reason as unknown;
        expect(err).toBeInstanceOf(TariffPlanOverlapError);
        expect((err as TariffPlanOverlapError).code).toBe(
          'tariff_plan_overlap',
        );

        // DB invariant: exactly one active row in scope.
        const count = await activeRowsForScope(
          seed.kgId,
          'monthly',
          'all_children',
          null,
        );
        expect(count).toBe(1);
      } finally {
        await seed.cleanup();
      }
    });

    it('concurrent creates in DIFFERENT scopes both succeed (no false serialisation)', async () => {
      const seed = await seedKg();
      const svc = buildService();
      try {
        // Same kg + window, different tariff_type — should NOT collide.
        const results = await Promise.allSettled([
          svc.create(seed.kgId, {
            name: 'Monthly',
            tariffType: 'monthly',
            amount: 50_000,
            appliesTo: 'all_children',
            validFrom: new Date('2026-01-01T00:00:00.000Z'),
          }),
          svc.create(seed.kgId, {
            name: 'Late pickup',
            tariffType: 'late_pickup_fee',
            amount: 2_000,
            appliesTo: 'all_children',
            validFrom: new Date('2026-01-01T00:00:00.000Z'),
          }),
        ]);
        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        expect(fulfilled.length).toBe(2);
      } finally {
        await seed.cleanup();
      }
    });

    it('3 concurrent creators on overlapping windows leave exactly 1 row', async () => {
      const seed = await seedKg();
      const svc = buildService();
      try {
        const results = await Promise.allSettled([
          svc.create(seed.kgId, {
            name: 'Plan A',
            tariffType: 'monthly',
            amount: 50_000,
            appliesTo: 'all_children',
            validFrom: new Date('2026-01-01T00:00:00.000Z'),
            validUntil: new Date('2026-06-30T00:00:00.000Z'),
          }),
          svc.create(seed.kgId, {
            name: 'Plan B',
            tariffType: 'monthly',
            amount: 60_000,
            appliesTo: 'all_children',
            validFrom: new Date('2026-04-01T00:00:00.000Z'),
            validUntil: new Date('2026-09-30T00:00:00.000Z'),
          }),
          svc.create(seed.kgId, {
            name: 'Plan C',
            tariffType: 'monthly',
            amount: 70_000,
            appliesTo: 'all_children',
            validFrom: new Date('2026-05-01T00:00:00.000Z'),
            validUntil: new Date('2026-12-31T00:00:00.000Z'),
          }),
        ]);
        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected');
        // The first arrival wins (whichever the lock dispenses to first);
        // the other two see the persisted row and reject with overlap.
        expect(fulfilled.length).toBe(1);
        expect(rejected.length).toBe(2);
        for (const r of rejected) {
          const err = (r as PromiseRejectedResult).reason as unknown;
          expect(err).toBeInstanceOf(TariffPlanOverlapError);
        }
        const count = await activeRowsForScope(
          seed.kgId,
          'monthly',
          'all_children',
          null,
        );
        expect(count).toBe(1);
      } finally {
        await seed.cleanup();
      }
    });
  },
);
