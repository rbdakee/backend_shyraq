/**
 * B24 K9 review fix — payment_account balance lost-update race spec.
 *
 * Self-skips when `INTEGRATION_DB !== '1'` so `npm test` stays green on
 * machines without a configured tenant DB. Run with:
 *
 *   $env:DATABASE_PORT='55432'; $env:DATABASE_USERNAME='shyraq_app';
 *   $env:DATABASE_PASSWORD='shyraq_app'; $env:INTEGRATION_DB='1';
 *   npm test -- --testPathPatterns='payment-account-balance.race'
 *
 * The bug (PRE-EXISTING B13): `PaymentAccountService.creditFromPayment` /
 * `debitForRefund` do read-modify-write on `payment_accounts.balance`. The
 * settlement advisory lock is keyed on `invoice_id`, but `payment_accounts`
 * is per-CHILD — so two concurrent settlements for DIFFERENT invoices of the
 * SAME child acquire DIFFERENT invoice locks → do NOT serialise → both read
 * the same balance and one credit is lost (last-writer-wins on the absolute
 * value written by `save`).
 *
 * The fix: a per-account advisory lock `billing:account:<accountId>` taken
 * INSIDE the ambient TX, before the read. The second crediter blocks until
 * the first commits, then reads the updated balance.
 *
 * Test: seed one kg + child + a `payment_accounts` row (balance 0). Fire TWO
 * concurrent `creditFromPayment` calls (50000 and 10000) for the SAME account,
 * each inside its OWN tenant-scoped TX (so they truly race). Assert the final
 * balance is 60000 — the sum of both credits, no lost update.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { MoneyKzt } from '@/shared-kernel/domain/money-kzt';
import { PaymentAccountRelationalRepository } from './infrastructure/persistence/relational/repositories/payment-account.relational.repository';
import { PaymentAccountTypeOrmEntity } from './infrastructure/persistence/relational/entities/payment-account.typeorm.entity';
import { PaymentAccountService } from './payment-account.service';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

class FixedClock extends ClockPort {
  constructor(private d: Date) {
    super();
  }
  now(): Date {
    return this.d;
  }
}

const NOW = new Date('2026-06-15T09:00:00.000Z');

describeIntegration('PaymentAccountService — balance race-integration', () => {
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
      entities: [PaymentAccountTypeOrmEntity],
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

  // ── helpers ────────────────────────────────────────────────────────────

  function makeService(): PaymentAccountService {
    const clock = new FixedClock(NOW);
    const accountRepo = new PaymentAccountRelationalRepository(
      dataSource.getRepository(PaymentAccountTypeOrmEntity),
    );
    return new PaymentAccountService(accountRepo, clock);
  }

  /**
   * Open a TX, set `app.kindergarten_id` GUC for RLS, push the EM into
   * tenantStorage so repos see it. Mirrors what TenantContextInterceptor
   * does for HTTP requests — each call gets its OWN connection/TX so the
   * two crediters genuinely race.
   */
  async function runScoped<T>(kgId: string, fn: () => Promise<T>): Promise<T> {
    return dataSource.transaction(async (em) => {
      await em.query(`SELECT set_config('app.kindergarten_id', $1, true)`, [
        kgId,
      ]);
      return tenantStorage.run({ kgId, bypass: false, entityManager: em }, () =>
        fn(),
      );
    });
  }

  /** Run something with bypass_rls — for setup/cleanup/read-back queries. */
  async function withBypass<T>(
    fn: (em: EntityManager) => Promise<T>,
  ): Promise<T> {
    return dataSource.transaction(async (em) => {
      await em.query(`SET LOCAL app.bypass_rls = 'true'`);
      return fn(em);
    });
  }

  async function seedKgWithAccount(): Promise<{
    kgId: string;
    childId: string;
    accountId: string;
    cleanup: () => Promise<void>;
  }> {
    const kgId = randomUUID();
    const childId = randomUUID();
    const accountId = randomUUID();
    const slug = `pa-race-${kgId.slice(0, 8)}`;
    await withBypass(async (m) => {
      await m.query(
        `INSERT INTO kindergartens (id, name, slug, is_active)
         VALUES ($1, 'PA Race KG', $2, true)`,
        [kgId, slug],
      );
      await m.query(
        `INSERT INTO children (id, kindergarten_id, full_name, date_of_birth, status)
         VALUES ($1, $2, 'PA Race Child', '2021-01-01', 'card_created')`,
        [childId, kgId],
      );
      await m.query(
        `INSERT INTO payment_accounts (id, kindergarten_id, child_id, balance)
         VALUES ($1, $2, $3, 0)`,
        [accountId, kgId, childId],
      );
    });

    const cleanup = async () => {
      await withBypass(async (m) => {
        await m.query(
          `DELETE FROM payment_accounts WHERE kindergarten_id = $1`,
          [kgId],
        );
        await m.query(`DELETE FROM children WHERE kindergarten_id = $1`, [
          kgId,
        ]);
        await m.query(`DELETE FROM kindergartens WHERE id = $1`, [kgId]);
      });
    };

    return { kgId, childId, accountId, cleanup };
  }

  async function readAccountBalance(
    kgId: string,
    accountId: string,
  ): Promise<number> {
    return withBypass(async (m) => {
      const rows = (await m.query(
        `SELECT balance::text AS b FROM payment_accounts
           WHERE id = $1 AND kindergarten_id = $2`,
        [accountId, kgId],
      )) as Array<{ b: string }>;
      return Number(rows[0]?.b ?? '0');
    });
  }

  // ── the race ──────────────────────────────────────────────────────────

  it('two concurrent credits on the same account both apply — no lost update (final = 60000)', async () => {
    const seed = await seedKgWithAccount();
    try {
      const svc = makeService();

      await Promise.all([
        runScoped(seed.kgId, () =>
          svc.creditFromPayment(
            seed.kgId,
            seed.accountId,
            MoneyKzt.fromKzt(50000),
          ),
        ),
        runScoped(seed.kgId, () =>
          svc.creditFromPayment(
            seed.kgId,
            seed.accountId,
            MoneyKzt.fromKzt(10000),
          ),
        ),
      ]);

      // The per-account advisory lock serialises the two read-modify-writes:
      // the second crediter blocks until the first commits, re-reads the
      // updated balance, then adds its own amount. Sum is preserved.
      expect(await readAccountBalance(seed.kgId, seed.accountId)).toBe(60000);
    } finally {
      await seed.cleanup();
    }
  });

  it('a credit and a debit on the same account net correctly under contention', async () => {
    const seed = await seedKgWithAccount();
    try {
      const svc = makeService();

      await Promise.all([
        runScoped(seed.kgId, () =>
          svc.creditFromPayment(
            seed.kgId,
            seed.accountId,
            MoneyKzt.fromKzt(50000),
          ),
        ),
        runScoped(seed.kgId, () =>
          svc.debitForRefund(
            seed.kgId,
            seed.accountId,
            MoneyKzt.fromKzt(20000),
          ),
        ),
      ]);

      // 0 + 50000 - 20000 = 30000, regardless of interleaving order.
      expect(await readAccountBalance(seed.kgId, seed.accountId)).toBe(30000);
    } finally {
      await seed.cleanup();
    }
  });
});
