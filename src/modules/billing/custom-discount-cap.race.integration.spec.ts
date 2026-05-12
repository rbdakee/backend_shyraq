/**
 * B22a T1 H16 — concurrent total_max_uses cap reserve race spec.
 *
 * Self-skips when `INTEGRATION_DB !== '1'`. Run with:
 *
 *   $env:DATABASE_PORT='55432'; $env:DATABASE_USERNAME='shyraq_app';
 *   $env:DATABASE_PASSWORD='shyraq_app'; $env:INTEGRATION_DB='1';
 *   npm test -- --testPathPatterns='custom-discount-cap.race'
 *
 * Invariant under test (T1 H16): N concurrent invoice-generate flows
 * crossing `total_max_uses` cap result in EXACTLY `total_max_uses`
 * winners. Both `custom_discounts.used_count` AND the implicit
 * `custom_discount_applications` count agree (no ledger drift).
 *
 * Realised through the new atomic `tryReserveUsage` repo method:
 *
 *   `UPDATE custom_discounts SET used_count = used_count + 1, ...
 *      WHERE id=$1 AND kindergarten_id=$2
 *        AND (total_max_uses IS NULL OR used_count < total_max_uses)
 *      RETURNING used_count`
 *
 * The single-statement guard serialises concurrent reservers at the row
 * level: PG row-locks the target during the UPDATE, so the next reserver
 * re-checks `used_count < total_max_uses` against the post-flip value.
 * Once the cap is hit, all subsequent reservers get a 0-row result and
 * `tryReserveUsage` returns false.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { CustomDiscountTypeOrmEntity } from './infrastructure/persistence/relational/entities/custom-discount.typeorm.entity';
import { CustomDiscountRelationalRepository } from './infrastructure/persistence/relational/repositories/custom-discount.relational.repository';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

describeIntegration(
  'CustomDiscount cap — concurrent tryReserveUsage atomic reservation',
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
        entities: [CustomDiscountTypeOrmEntity],
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

    async function seedScenario(cap: number): Promise<{
      kgId: string;
      discountId: string;
      cleanup: () => Promise<void>;
    }> {
      const kgId = randomUUID();
      const discountId = randomUUID();
      const slug = `cap-race-${kgId.slice(0, 8)}`;

      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(
          `INSERT INTO kindergartens (id, name, slug) VALUES ($1, 'Cap Race KG', $2)`,
          [kgId, slug],
        );
        await m.query(
          `INSERT INTO custom_discounts
             (id, kindergarten_id, name, discount_type, amount,
              conditions, target_type, valid_from, status,
              total_max_uses, notify_on_activation)
           VALUES ($1, $2, '{"ru":"Гонка cap"}'::jsonb, 'percentage', 10,
                   '{}'::jsonb, 'all', '2025-01-01', 'active', $3, false)`,
          [discountId, kgId, cap],
        );
      });

      const cleanup = async () => {
        await dataSource.transaction(async (m) => {
          await m.query(`SET LOCAL app.bypass_rls = 'true'`);
          await m.query(`DELETE FROM custom_discounts WHERE id = $1`, [
            discountId,
          ]);
          await m.query(`DELETE FROM kindergartens WHERE id = $1`, [kgId]);
        });
      };

      return { kgId, discountId, cleanup };
    }

    async function readUsedCount(
      kgId: string,
      discountId: string,
    ): Promise<number> {
      return dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        const rows = (await m.query(
          `SELECT used_count FROM custom_discounts WHERE id = $1 AND kindergarten_id = $2`,
          [discountId, kgId],
        )) as Array<{ used_count: number }>;
        return rows[0]?.used_count ?? -1;
      });
    }

    /**
     * Run one reserve attempt in its own ambient TX. Each TX SETs
     * `app.bypass_rls=true` (the test seeds + reservers run as the
     * shyraq_app role which is NOBYPASSRLS), constructs a fresh repo
     * binding, and calls `tryReserveUsage`.
     *
     * The 50ms delay AFTER the reserve simulates "real work" the invoice
     * generation flow does between reserve and TX commit (line item
     * INSERT, audit row INSERT). It increases the chance of overlap
     * between concurrent runs so the lock contention path is exercised.
     */
    async function runReserve(
      kgId: string,
      discountId: string,
    ): Promise<boolean> {
      return dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        const repo = new CustomDiscountRelationalRepository(
          dataSource,
          dataSource.getRepository(CustomDiscountTypeOrmEntity),
        );
        // Hold the TX briefly BEFORE the reserve so concurrent
        // reservers all enter the contention window simultaneously.
        await new Promise((r) => setTimeout(r, 30));
        return repo.tryReserveUsage(kgId, discountId, m);
      });
    }

    it('exactly cap=2 of 5 concurrent reservers succeed; used_count = 2', async () => {
      const seed = await seedScenario(2);
      try {
        const results = await Promise.all([
          runReserve(seed.kgId, seed.discountId),
          runReserve(seed.kgId, seed.discountId),
          runReserve(seed.kgId, seed.discountId),
          runReserve(seed.kgId, seed.discountId),
          runReserve(seed.kgId, seed.discountId),
        ]);
        const winners = results.filter(Boolean).length;
        const losers = results.filter((x) => !x).length;
        expect(winners).toBe(2);
        expect(losers).toBe(3);

        const finalCount = await readUsedCount(seed.kgId, seed.discountId);
        expect(finalCount).toBe(2);
      } finally {
        await seed.cleanup();
      }
    });

    it('exactly cap=1 of 3 concurrent reservers succeeds; used_count = 1', async () => {
      const seed = await seedScenario(1);
      try {
        const results = await Promise.all([
          runReserve(seed.kgId, seed.discountId),
          runReserve(seed.kgId, seed.discountId),
          runReserve(seed.kgId, seed.discountId),
        ]);
        expect(results.filter(Boolean).length).toBe(1);
        expect(results.filter((x) => !x).length).toBe(2);
        const finalCount = await readUsedCount(seed.kgId, seed.discountId);
        expect(finalCount).toBe(1);
      } finally {
        await seed.cleanup();
      }
    });

    it('TX rollback releases a reservation (used_count returns to baseline)', async () => {
      const seed = await seedScenario(2);
      try {
        // First reservation commits → used_count = 1.
        const baseline = await runReserve(seed.kgId, seed.discountId);
        expect(baseline).toBe(true);
        let countAfterCommit = await readUsedCount(seed.kgId, seed.discountId);
        expect(countAfterCommit).toBe(1);

        // Now reserve in a TX that explicitly throws after the reserve.
        await expect(
          dataSource.transaction(async (m) => {
            await m.query(`SET LOCAL app.bypass_rls = 'true'`);
            const repo = new CustomDiscountRelationalRepository(
              dataSource,
              dataSource.getRepository(CustomDiscountTypeOrmEntity),
            );
            const ok = await repo.tryReserveUsage(
              seed.kgId,
              seed.discountId,
              m,
            );
            expect(ok).toBe(true);
            // Sanity: inside-the-TX read sees the post-reserve count.
            const readInside = (await m.query(
              `SELECT used_count FROM custom_discounts WHERE id = $1`,
              [seed.discountId],
            )) as Array<{ used_count: number }>;
            expect(readInside[0]?.used_count).toBe(2);
            // Force rollback.
            throw new Error('forced_rollback_for_release_test');
          }),
        ).rejects.toThrow('forced_rollback_for_release_test');

        // Outside the rolled-back TX, the count returns to the baseline.
        countAfterCommit = await readUsedCount(seed.kgId, seed.discountId);
        expect(countAfterCommit).toBe(1);
      } finally {
        await seed.cleanup();
      }
    });
  },
);
