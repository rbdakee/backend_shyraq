/**
 * B16 T8 H1 — concurrent custom-discount apply race spec.
 *
 * Self-skips when `INTEGRATION_DB !== '1'`. Run with:
 *
 *   $env:DATABASE_PORT='55432'; $env:DATABASE_USERNAME='shyraq_app';
 *   $env:DATABASE_PASSWORD='shyraq_app'; $env:INTEGRATION_DB='1';
 *   npm test -- --testPathPatterns='custom-discounts-apply.race'
 *
 * Invariant under test (T6 H1): two concurrent invoice flows for the
 * same (child, custom_discount) pair are serialised by
 * `pg_advisory_xact_lock(hashtext('discount:apply:'||kg||':'||child||':'||id))`.
 *
 * The lock guards the read-then-write window in
 * `InvoiceService.buildCustomDiscountInputs`:
 *   1. `acquireDiscountApplyAdvisoryLock(kg, customDiscountId, childId)`
 *   2. `customDiscountApplications.countByChildAndDiscount(...)` → returns N
 *   3. (eligibility check `N < max_uses_per_child`)
 *   4. … invoice + line item INSERT happens later in the flow
 *   5. `customDiscountApplications.create(...)` — adds another row
 *
 * Without the lock, two flows could both see `N=0` against `cap=1` and
 * both write a second application row — exceeding the per-child cap.
 *
 * This spec simulates that exact pattern through the real PG-backed
 * `CustomDiscountRelationalRepository.acquireDiscountApplyAdvisoryLock`
 * and `CustomDiscountApplicationRelationalRepository`, asserting that
 * two concurrent TXs serialise — exactly one inserts a row, the other
 * sees the count post-insert and short-circuits.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { CustomDiscountTypeOrmEntity } from './infrastructure/persistence/relational/entities/custom-discount.typeorm.entity';
import { CustomDiscountApplicationTypeOrmEntity } from './infrastructure/persistence/relational/entities/custom-discount-application.typeorm.entity';
import { CustomDiscountRelationalRepository } from './infrastructure/persistence/relational/repositories/custom-discount.relational.repository';
import { CustomDiscountApplicationRelationalRepository } from './infrastructure/persistence/relational/repositories/custom-discount-application.relational.repository';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

describeIntegration(
  'CustomDiscount apply — concurrent (child, discount) advisory lock serialisation',
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
        entities: [
          CustomDiscountTypeOrmEntity,
          CustomDiscountApplicationTypeOrmEntity,
        ],
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

    async function seedScenario(): Promise<{
      kgId: string;
      childId: string;
      discountId: string;
      invoiceId1: string;
      invoiceId2: string;
      lineItem1: string;
      lineItem2: string;
      cleanup: () => Promise<void>;
    }> {
      const kgId = randomUUID();
      const childId = randomUUID();
      const discountId = randomUUID();
      const paymentAccountId = randomUUID();
      const invoiceId1 = randomUUID();
      const invoiceId2 = randomUUID();
      const lineItem1 = randomUUID();
      const lineItem2 = randomUUID();
      const slug = `apply-race-${kgId.slice(0, 8)}`;

      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(
          `INSERT INTO kindergartens (id, name, slug) VALUES ($1, 'Apply Race KG', $2)`,
          [kgId, slug],
        );
        await m.query(
          `INSERT INTO children (id, kindergarten_id, full_name, date_of_birth, status)
           VALUES ($1, $2, 'Race Child', '2021-01-01', 'card_created')`,
          [childId, kgId],
        );
        await m.query(
          `INSERT INTO payment_accounts (id, kindergarten_id, child_id, balance)
           VALUES ($1, $2, $3, 0)`,
          [paymentAccountId, kgId, childId],
        );
        // Two pre-created invoices + line items so each "flow" can reference
        // a real invoice + line_item id when writing the application row.
        for (const [iid, lid] of [
          [invoiceId1, lineItem1],
          [invoiceId2, lineItem2],
        ] as const) {
          await m.query(
            `INSERT INTO invoices
               (id, kindergarten_id, child_id, payment_account_id, invoice_type,
                period_start, period_end, amount_due, amount_after_discount,
                status, due_date)
             VALUES ($1, $2, $3, $4, 'monthly',
                     '2026-06-01', '2026-06-30', 100000, 100000,
                     'pending', '2026-06-10')`,
            [iid, kgId, childId, paymentAccountId],
          );
          await m.query(
            `INSERT INTO invoice_line_items
               (id, invoice_id, kindergarten_id, description, quantity, unit_price, line_total)
             VALUES ($1, $2, $3, 'Monthly fee', 1, 100000, 100000)`,
            [lid, iid, kgId],
          );
        }
        // The discount has max_uses_per_child=1 so we can prove the lock
        // prevents a second application row from being written.
        await m.query(
          `INSERT INTO custom_discounts
             (id, kindergarten_id, name, discount_type, amount,
              conditions, target_type, valid_from, status,
              max_uses_per_child, notify_on_activation)
           VALUES ($1, $2, '{"ru":"Гонка"}'::jsonb, 'percentage', 10,
                   '{}'::jsonb, 'all', '2025-01-01', 'active', 1, false)`,
          [discountId, kgId],
        );
      });

      const cleanup = async () => {
        await dataSource.transaction(async (m) => {
          await m.query(`SET LOCAL app.bypass_rls = 'true'`);
          await m.query(
            `DELETE FROM custom_discount_applications WHERE kindergarten_id = $1`,
            [kgId],
          );
          await m.query(`DELETE FROM custom_discounts WHERE id = $1`, [
            discountId,
          ]);
          await m.query(
            `DELETE FROM invoice_line_items WHERE kindergarten_id = $1`,
            [kgId],
          );
          await m.query(`DELETE FROM invoices WHERE kindergarten_id = $1`, [
            kgId,
          ]);
          await m.query(`DELETE FROM payment_accounts WHERE id = $1`, [
            paymentAccountId,
          ]);
          await m.query(`DELETE FROM children WHERE id = $1`, [childId]);
          await m.query(`DELETE FROM kindergartens WHERE id = $1`, [kgId]);
        });
      };

      return {
        kgId,
        childId,
        discountId,
        invoiceId1,
        invoiceId2,
        lineItem1,
        lineItem2,
        cleanup,
      };
    }

    async function countApplications(
      kgId: string,
      childId: string,
      discountId: string,
    ): Promise<number> {
      return dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        const rows = (await m.query(
          `SELECT COUNT(*)::int AS c
             FROM custom_discount_applications
            WHERE kindergarten_id = $1 AND child_id = $2 AND custom_discount_id = $3`,
          [kgId, childId, discountId],
        )) as Array<{ c: number }>;
        return rows[0]?.c ?? 0;
      });
    }

    /**
     * Run one "invoice flow" in its own ambient TX:
     *   1. acquire advisory lock for (child, discount)
     *   2. count existing applications
     *   3. if `count < cap`, insert an application row
     *   4. small delay before returning so concurrent flow contends
     *
     * Returns whether the flow inserted a row (true) or short-circuited (false).
     */
    async function runFlow(
      kgId: string,
      childId: string,
      discountId: string,
      invoiceId: string,
      lineItemId: string,
      cap: number,
    ): Promise<boolean> {
      return dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        const repo = new CustomDiscountRelationalRepository(
          dataSource,
          dataSource.getRepository(CustomDiscountTypeOrmEntity),
        );
        const appRepo = new CustomDiscountApplicationRelationalRepository(
          dataSource.getRepository(CustomDiscountApplicationTypeOrmEntity),
        );
        await repo.acquireDiscountApplyAdvisoryLock(
          kgId,
          discountId,
          childId,
          m,
        );
        const used = await appRepo.countByChildAndDiscount(
          kgId,
          childId,
          discountId,
          m,
        );
        if (used >= cap) {
          // Lock holder prevented over-cap: short-circuit (matches the
          // service-layer "skip with warn" decision when cap reached).
          return false;
        }
        // Simulate work — the application write happens after the count
        // in real flow. A small delay forces interleaving in the absence
        // of the lock; with the lock, the second flow blocks until the
        // first commits.
        await new Promise((r) => setTimeout(r, 50));
        await appRepo.create(
          {
            kindergartenId: kgId,
            customDiscountId: discountId,
            invoiceId,
            invoiceLineItemId: lineItemId,
            childId,
            amountApplied: 1000,
          },
          m,
        );
        return true;
      });
    }

    it('serializes 2 concurrent (child, discount) flows — exactly 1 application row', async () => {
      const seed = await seedScenario();
      try {
        const [a, b] = await Promise.all([
          runFlow(
            seed.kgId,
            seed.childId,
            seed.discountId,
            seed.invoiceId1,
            seed.lineItem1,
            1,
          ),
          runFlow(
            seed.kgId,
            seed.childId,
            seed.discountId,
            seed.invoiceId2,
            seed.lineItem2,
            1,
          ),
        ]);

        const winners = [a, b].filter(Boolean).length;
        const losers = [a, b].filter((x) => !x).length;
        expect(winners).toBe(1);
        expect(losers).toBe(1);

        const final = await countApplications(
          seed.kgId,
          seed.childId,
          seed.discountId,
        );
        expect(final).toBe(1);
      } finally {
        await seed.cleanup();
      }
    });
  },
);
