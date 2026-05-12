/**
 * B21 T3 step 5 — ProRataRefundProcessor concurrent-run race spec.
 *
 * Self-skips when `INTEGRATION_DB !== '1'` so `npm test` stays green on
 * machines without a configured tenant DB. Run with:
 *
 *   $env:DATABASE_PORT='55432'; $env:DATABASE_USERNAME='shyraq_app';
 *   $env:DATABASE_PASSWORD='shyraq_app'; $env:INTEGRATION_DB='1';
 *   npm test -- --testPathPatterns='pro-rata-refund.race'
 *
 * Invariant under test: idempotency of `runForChild` under concurrent
 * invocation. Five callers fire `runForChild(kg, child, archivedAt)`
 * in parallel for the SAME (kg, child) tuple. The advisory lock keyed
 * on `hashtext('billing:pro-rata:'||kg||':'||childId)` serialises them
 * inside `acquireProRataAdvisoryLock`; the `findPendingProRataForChild
 * SinceArchive` idempotency check kicks in after the winner commits.
 * Post-condition: exactly 1 refund row in the DB (status='pending',
 * reason='pro_rata_archive'), not 5.
 *
 * The spec uses the real PG-backed `RefundRelationalRepository`,
 * `InvoiceRelationalRepository`, `KindergartenHolidayRelationalRepository`,
 * and `ChildRelationalRepository` so the advisory lock + the SQL join
 * idempotency check are exercised end-to-end.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { ChildRelationalRepository } from '@/modules/child/infrastructure/persistence/relational/repositories/child.repository';
import { ChildEntity } from '@/modules/child/infrastructure/persistence/relational/entities/child.entity';
import { GroupEntity } from '@/modules/group/infrastructure/persistence/relational/entities/group.entity';
import { KindergartenEntity } from '@/modules/kindergarten/infrastructure/persistence/relational/entities/kindergarten.entity';
import { LocationEntity } from '@/modules/location/infrastructure/persistence/relational/entities/location.entity';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { InvoiceRelationalRepository } from './infrastructure/persistence/relational/repositories/invoice.relational.repository';
import { KindergartenHolidayRelationalRepository } from './infrastructure/persistence/relational/repositories/kindergarten-holiday.relational.repository';
import { PaymentRelationalRepository } from './infrastructure/persistence/relational/repositories/payment.relational.repository';
import { RefundRelationalRepository } from './infrastructure/persistence/relational/repositories/refund.relational.repository';
import { InvoiceTypeOrmEntity } from './infrastructure/persistence/relational/entities/invoice.typeorm.entity';
import { KindergartenHolidayTypeOrmEntity } from './infrastructure/persistence/relational/entities/kindergarten-holiday.typeorm.entity';
import { PaymentTypeOrmEntity } from './infrastructure/persistence/relational/entities/payment.typeorm.entity';
import { RefundTypeOrmEntity } from './infrastructure/persistence/relational/entities/refund.typeorm.entity';
import { ProRataRefundProcessor } from './pro-rata-refund.processor';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

const ARCHIVED_AT = new Date('2026-06-15T09:00:00.000Z');
const PERIOD_START = new Date('2026-06-01T00:00:00.000Z');
const PERIOD_END = new Date('2026-06-30T00:00:00.000Z');
const INVOICE_AMOUNT = 60000;

class FixedClock extends ClockPort {
  constructor(private readonly d: Date) {
    super();
  }
  now(): Date {
    return this.d;
  }
}

describeIntegration(
  'ProRataRefundProcessor — concurrent runForChild produces exactly 1 refund',
  () => {
    jest.setTimeout(120_000);

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
          ChildEntity,
          GroupEntity,
          KindergartenEntity,
          LocationEntity,
          InvoiceTypeOrmEntity,
          KindergartenHolidayTypeOrmEntity,
          PaymentTypeOrmEntity,
          RefundTypeOrmEntity,
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

    function makeProcessor(): ProRataRefundProcessor {
      const refundRepo = new RefundRelationalRepository(
        dataSource,
        dataSource.getRepository(RefundTypeOrmEntity),
      );
      const invoiceRepo = new InvoiceRelationalRepository(
        dataSource,
        dataSource.getRepository(InvoiceTypeOrmEntity),
      );
      const holidayRepo = new KindergartenHolidayRelationalRepository(
        dataSource.getRepository(KindergartenHolidayTypeOrmEntity),
      );
      const paymentRepo = new PaymentRelationalRepository(
        dataSource,
        dataSource.getRepository(PaymentTypeOrmEntity),
      );
      const childRepo = new ChildRelationalRepository(
        dataSource.getRepository(ChildEntity),
        dataSource,
      );
      const clock = new FixedClock(ARCHIVED_AT);
      return new ProRataRefundProcessor(
        refundRepo,
        invoiceRepo,
        holidayRepo,
        paymentRepo,
        childRepo,
        clock,
        dataSource,
      );
    }

    /**
     * Seed: one kindergarten with one archived child, one payment account,
     * one open invoice for the current month covering the archive date.
     * No tariff_assignments — irrelevant for the refund processor; the
     * conditional UPDATE on children flipping to 'archived' is what
     * matters.
     */
    async function seedArchivedChildWithInvoice(): Promise<{
      kgId: string;
      childId: string;
      invoiceId: string;
      cleanup: () => Promise<void>;
    }> {
      const kgId = randomUUID();
      const childId = randomUUID();
      const invoiceId = randomUUID();
      const userId = randomUUID();
      const slug = `pro-rata-race-${kgId.slice(0, 8)}`;
      const phone = `+7700${kgId.replace(/-/g, '').slice(0, 7)}`;
      const paymentAccountId = randomUUID();
      const paymentId = randomUUID();

      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(
          `INSERT INTO kindergartens (id, name, slug, is_active)
           VALUES ($1, 'Pro-Rata Race KG', $2, true)`,
          [kgId, slug],
        );
        await m.query(
          `INSERT INTO users (id, phone, full_name)
           VALUES ($1, $2, 'Race Admin')`,
          [userId, phone],
        );
        await m.query(
          `INSERT INTO children
             (id, kindergarten_id, full_name, date_of_birth, status,
              archived_at, archive_reason)
           VALUES ($1, $2, 'Race Child', '2021-01-01', 'archived',
                   $3, 'race-test')`,
          [childId, kgId, ARCHIVED_AT],
        );
        await m.query(
          `INSERT INTO payment_accounts (id, kindergarten_id, child_id, balance)
           VALUES ($1, $2, $3, 0)`,
          [paymentAccountId, kgId, childId],
        );
        await m.query(
          `INSERT INTO invoices
             (id, kindergarten_id, child_id, payment_account_id,
              invoice_type, period_start, period_end, amount_due,
              amount_after_discount, status, due_date)
           VALUES ($1, $2, $3, $4, 'monthly', $5, $6, $7, $7, 'pending', $5)`,
          [
            invoiceId,
            kgId,
            childId,
            paymentAccountId,
            PERIOD_START,
            PERIOD_END,
            INVOICE_AMOUNT,
          ],
        );
        // Seed a completed payment so the processor has a non-null
        // payment_id to attach the refund to (current schema constraint
        // — see T6 carry-forward note in pro-rata-refund.processor.ts).
        await m.query(
          `INSERT INTO payments
             (id, kindergarten_id, invoice_id, child_id, amount,
              provider, provider_txn_id, idempotency_key, status, paid_at)
           VALUES ($1, $2, $3, $4, $5, 'mock', 'tx-1', $6,
                   'completed', $7)`,
          [
            paymentId,
            kgId,
            invoiceId,
            childId,
            INVOICE_AMOUNT,
            `idem-${paymentId}`,
            new Date('2026-06-10T00:00:00.000Z'),
          ],
        );
      });

      const cleanup = async () => {
        await dataSource.transaction(async (m) => {
          await m.query(`SET LOCAL app.bypass_rls = 'true'`);
          await m.query(`DELETE FROM refunds WHERE kindergarten_id = $1`, [
            kgId,
          ]);
          await m.query(`DELETE FROM payments WHERE kindergarten_id = $1`, [
            kgId,
          ]);
          await m.query(`DELETE FROM invoices WHERE kindergarten_id = $1`, [
            kgId,
          ]);
          await m.query(
            `DELETE FROM payment_accounts WHERE kindergarten_id = $1`,
            [kgId],
          );
          await m.query(`DELETE FROM children WHERE kindergarten_id = $1`, [
            kgId,
          ]);
          await m.query(`DELETE FROM users WHERE id = $1`, [userId]);
          await m.query(`DELETE FROM kindergartens WHERE id = $1`, [kgId]);
        });
      };

      return { kgId, childId, invoiceId, cleanup };
    }

    async function countProRataRefunds(
      kgId: string,
      childId: string,
    ): Promise<number> {
      return dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        const rows = (await m.query(
          `SELECT COUNT(*)::int AS c
             FROM refunds r
             JOIN invoices i ON i.id = r.invoice_id
            WHERE r.kindergarten_id = $1
              AND i.child_id = $2
              AND r.reason = 'pro_rata_archive'`,
          [kgId, childId],
        )) as Array<{ c: number }>;
        return rows[0]?.c ?? 0;
      });
    }

    it('serializes 5 concurrent runForChild calls — exactly 1 refund row created', async () => {
      const seed = await seedArchivedChildWithInvoice();
      try {
        const processor = makeProcessor();

        // Five concurrent invocations targeting the same (kg, child).
        // The advisory lock keyed on hashtext('billing:pro-rata:'||kg||':'||child)
        // serialises them; the first committer writes the refund, the
        // remaining four see it in findPendingProRataForChildSinceArchive
        // and return { kind: 'skipped', reason: 'refund_already_exists' }.
        const outcomes = await Promise.all(
          Array.from({ length: 5 }, () =>
            processor.runForChild(seed.kgId, seed.childId, ARCHIVED_AT),
          ),
        );

        const created = outcomes.filter((o) => o.kind === 'created');
        const skipped = outcomes.filter(
          (o) => o.kind === 'skipped' && o.reason === 'refund_already_exists',
        );

        // Exactly one caller wrote the refund; the other four observed it
        // and short-circuited. The DB row count is the load-bearing
        // assertion — the in-flight outcome split may vary by scheduling
        // (sometimes two callers serialise serially without the second
        // hitting the find-existing branch on its FIRST scan).
        expect(created).toHaveLength(1);
        expect(skipped.length).toBeGreaterThanOrEqual(4);

        const dbCount = await countProRataRefunds(seed.kgId, seed.childId);
        expect(dbCount).toBe(1);
      } finally {
        await seed.cleanup();
      }
    });
  },
);
