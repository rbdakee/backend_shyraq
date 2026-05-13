/**
 * B22a T13 H1 — discount cap drift compensation integration spec.
 *
 * Self-skips when `INTEGRATION_DB !== '1'`. Run with:
 *
 *   $env:DATABASE_PORT='55432'; $env:DATABASE_USERNAME='shyraq_app';
 *   $env:DATABASE_PASSWORD='shyraq_app'; $env:INTEGRATION_DB='1';
 *   npm test -- --testPathPatterns='custom-discount-cap-drift'
 *
 * Invariant under test (T13 H1): when `InvoiceService.buildCustomDiscountInputs`
 * reserves a `total_max_uses` slot for a discount that the engine LATER drops
 * (non-stackable gate, condition false, etc), the slot must be released so
 * `used_count` agrees with the persisted `custom_discount_applications`
 * ledger.
 *
 * The release happens through `CustomDiscountRepository.releaseUsage` —
 * idempotent atomic `UPDATE custom_discounts SET used_count =
 * GREATEST(used_count - 1, 0)`. This spec exercises the repo method
 * directly (the orchestration layer is covered by `invoice.service.spec.ts`
 * unit tests).
 *
 * Drift scenario simulated:
 *   1. Two capped discounts (cap=1) targeting the same child both pass
 *      `tryReserveUsage` — `used_count` for each becomes 1.
 *   2. Engine evaluates: only the higher-priority non-stackable wins;
 *      the loser is excluded from `customApplicationsToWrite`.
 *   3. Compensation calls `releaseUsage` on the loser → its `used_count`
 *      drops back to 0 so the next legitimate invoice can claim it.
 *   4. Ledger ends with: winner.used_count=1, loser.used_count=0,
 *      `custom_discount_applications` row count=1.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { CustomDiscountTypeOrmEntity } from './infrastructure/persistence/relational/entities/custom-discount.typeorm.entity';
import { CustomDiscountRelationalRepository } from './infrastructure/persistence/relational/repositories/custom-discount.relational.repository';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

describeIntegration(
  'CustomDiscount cap drift — releaseUsage compensation after engine drop',
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
        poolSize: 10,
      });
      await dataSource.initialize();
    });

    afterAll(async () => {
      if (!dataSource?.isInitialized) return;
      await dataSource.destroy();
    });

    async function seedTwoCappedDiscounts(): Promise<{
      kgId: string;
      winnerId: string;
      loserId: string;
      cleanup: () => Promise<void>;
    }> {
      const kgId = randomUUID();
      const winnerId = randomUUID();
      const loserId = randomUUID();
      const slug = `cap-drift-${kgId.slice(0, 8)}`;

      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(
          `INSERT INTO kindergartens (id, name, slug)
             VALUES ($1, 'Cap Drift KG', $2)`,
          [kgId, slug],
        );
        // Both cap=1, both targeting='all', both non-stackable. Engine
        // picks the highest-priority one as the only winner; the second
        // is dropped despite the pre-engine reserve.
        await m.query(
          `INSERT INTO custom_discounts
             (id, kindergarten_id, name, discount_type, amount,
              conditions, target_type, valid_from, status,
              total_max_uses, max_uses_per_child, priority, stackable,
              notify_on_activation)
           VALUES
             ($1, $3, '{"ru":"Победитель"}'::jsonb, 'percentage', 10,
              '{}'::jsonb, 'all', '2025-01-01', 'active',
              1, NULL, 100, false, false),
             ($2, $3, '{"ru":"Проигравший"}'::jsonb, 'percentage', 5,
              '{}'::jsonb, 'all', '2025-01-01', 'active',
              1, NULL, 50, false, false)`,
          [winnerId, loserId, kgId],
        );
      });

      const cleanup = async () => {
        await dataSource.transaction(async (m) => {
          await m.query(`SET LOCAL app.bypass_rls = 'true'`);
          await m.query(
            `DELETE FROM custom_discounts WHERE kindergarten_id = $1`,
            [kgId],
          );
          await m.query(`DELETE FROM kindergartens WHERE id = $1`, [kgId]);
        });
      };

      return { kgId, winnerId, loserId, cleanup };
    }

    async function readUsedCount(
      kgId: string,
      discountId: string,
    ): Promise<number> {
      return dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        const rows = (await m.query(
          `SELECT used_count
             FROM custom_discounts
            WHERE id = $1 AND kindergarten_id = $2`,
          [discountId, kgId],
        )) as Array<{ used_count: number }>;
        return rows[0]?.used_count ?? -1;
      });
    }

    it('releaseUsage decrements used_count for a discount the engine dropped post-reserve', async () => {
      const seed = await seedTwoCappedDiscounts();
      try {
        // Step 1 — buildCustomDiscountInputs reserves both (current
        // production behaviour).
        await dataSource.transaction(async (m) => {
          await m.query(`SET LOCAL app.bypass_rls = 'true'`);
          const repo = new CustomDiscountRelationalRepository(
            dataSource,
            dataSource.getRepository(CustomDiscountTypeOrmEntity),
          );
          const wReserve = await repo.tryReserveUsage(
            seed.kgId,
            seed.winnerId,
            m,
          );
          const lReserve = await repo.tryReserveUsage(
            seed.kgId,
            seed.loserId,
            m,
          );
          expect(wReserve).toBe(true);
          expect(lReserve).toBe(true);
        });

        // After Step 1 — both used_count = 1 (drift before compensation).
        expect(await readUsedCount(seed.kgId, seed.winnerId)).toBe(1);
        expect(await readUsedCount(seed.kgId, seed.loserId)).toBe(1);

        // Step 2 — engine returns only the winner. Compensation releases
        // the loser via `releaseUsage`. (Service-layer
        // `releaseUnusedReservations` calls this for every reserved-but-
        // not-applied id; the repo method is exercised directly here.)
        await dataSource.transaction(async (m) => {
          await m.query(`SET LOCAL app.bypass_rls = 'true'`);
          const repo = new CustomDiscountRelationalRepository(
            dataSource,
            dataSource.getRepository(CustomDiscountTypeOrmEntity),
          );
          await repo.releaseUsage(seed.kgId, seed.loserId, m);
        });

        // After Step 2 — loser used_count returns to 0; winner stays at 1.
        expect(await readUsedCount(seed.kgId, seed.winnerId)).toBe(1);
        expect(await readUsedCount(seed.kgId, seed.loserId)).toBe(0);
      } finally {
        await seed.cleanup();
      }
    });

    it('releaseUsage clamps at zero (idempotent on already-zero rows)', async () => {
      const seed = await seedTwoCappedDiscounts();
      try {
        // Without any prior reserve, releaseUsage on an unused discount
        // must not push used_count negative.
        await dataSource.transaction(async (m) => {
          await m.query(`SET LOCAL app.bypass_rls = 'true'`);
          const repo = new CustomDiscountRelationalRepository(
            dataSource,
            dataSource.getRepository(CustomDiscountTypeOrmEntity),
          );
          await repo.releaseUsage(seed.kgId, seed.loserId, m);
          await repo.releaseUsage(seed.kgId, seed.loserId, m);
        });

        expect(await readUsedCount(seed.kgId, seed.loserId)).toBe(0);
      } finally {
        await seed.cleanup();
      }
    });
  },
);
