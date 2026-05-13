/**
 * B16 — concurrent CustomDiscountService.activate race spec.
 *
 * Self-skips when `INTEGRATION_DB !== '1'`. Run with:
 *
 *   $env:DATABASE_PORT='55432'; $env:DATABASE_USERNAME='shyraq_app';
 *   $env:DATABASE_PASSWORD='shyraq_app'; $env:INTEGRATION_DB='1';
 *   npm test -- --testPathPatterns='custom-discount-activation.race'
 *
 * Invariant under test: two concurrent `activate(kg, id)` calls on the
 * same draft discount are serialised by the
 * `pg_advisory_xact_lock(hashtext('discount:activation:'||kg||':'||id))`
 * + the conditional `transitionStatus('draft' → 'active')`.
 *
 * Expected outcome: exactly ONE caller wins (returns the activated row),
 * the other gets `CustomDiscountStatusInvalidError` (from='active' attempt).
 * The DB ends up with `status='active'` regardless of caller order.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { InMemoryNotificationAdapter } from '@/common/notifications/in-memory-notification.adapter';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { TypeOrmTransactionRunnerAdapter } from '@/shared-kernel/infrastructure/adapters/typeorm-transaction-runner.adapter';
import { CustomDiscountTypeOrmEntity } from './infrastructure/persistence/relational/entities/custom-discount.typeorm.entity';
import { CustomDiscountApplicationTypeOrmEntity } from './infrastructure/persistence/relational/entities/custom-discount-application.typeorm.entity';
import { CustomDiscountRelationalRepository } from './infrastructure/persistence/relational/repositories/custom-discount.relational.repository';
import { CustomDiscountApplicationRelationalRepository } from './infrastructure/persistence/relational/repositories/custom-discount-application.relational.repository';
import { CustomDiscountService } from './custom-discount.service';
import { CustomDiscountStatusInvalidError } from './domain/errors/custom-discount-status-invalid.error';
import { DiscountTargetResolver } from './discount-target-resolver';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

const NOW = new Date('2026-06-15T09:00:00.000Z');

class FixedClock extends ClockPort {
  now(): Date {
    return NOW;
  }
}

/** Stub resolver that returns no targets so notification fan-out is a no-op. */
class NoopTargetResolver {
  resolveTargetChildIds(): Promise<Set<string>> {
    return Promise.resolve(new Set());
  }
  filterDiscountsForChild(
    _kgId: string,
    _childId: string,
    snapshots: never[],
  ): Promise<never[]> {
    return Promise.resolve(snapshots);
  }
}

describeIntegration(
  'CustomDiscountService — concurrent activate (advisory lock + conditional transitionStatus)',
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

    function makeService(): {
      svc: CustomDiscountService;
    } {
      const repo = new CustomDiscountRelationalRepository(
        dataSource,
        dataSource.getRepository(CustomDiscountTypeOrmEntity),
      );
      const appRepo = new CustomDiscountApplicationRelationalRepository(
        dataSource.getRepository(CustomDiscountApplicationTypeOrmEntity),
      );
      const notif = new InMemoryNotificationAdapter();
      const resolver =
        new NoopTargetResolver() as unknown as DiscountTargetResolver;
      const svc = new CustomDiscountService(
        repo,
        appRepo,
        notif,
        new TypeOrmTransactionRunnerAdapter(dataSource),
        resolver,
        new FixedClock(),
      );
      return { svc };
    }

    async function seedDraftDiscount(): Promise<{
      kgId: string;
      discountId: string;
      cleanup: () => Promise<void>;
    }> {
      const kgId = randomUUID();
      const slug = `b16-race-${kgId.slice(0, 8)}`;
      const discountId = randomUUID();

      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(
          `INSERT INTO kindergartens (id, name, slug) VALUES ($1, 'B16 Race KG', $2)`,
          [kgId, slug],
        );
        await m.query(
          `INSERT INTO custom_discounts
             (id, kindergarten_id, name, discount_type, amount,
              conditions, target_type, valid_from, status,
              notify_on_activation)
           VALUES ($1, $2, '{"ru":"Гонка"}'::jsonb, 'percentage', 10,
                   '{}'::jsonb, 'all', '2025-01-01', 'draft', false)`,
          [discountId, kgId],
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

    async function readStatus(
      kgId: string,
      discountId: string,
    ): Promise<string> {
      return dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        const rows = (await m.query(
          `SELECT status FROM custom_discounts WHERE id = $1 AND kindergarten_id = $2`,
          [discountId, kgId],
        )) as Array<{ status: string }>;
        return rows[0]?.status ?? 'missing';
      });
    }

    it('serializes 2 concurrent activate() calls — exactly one wins, other rejects', async () => {
      const seed = await seedDraftDiscount();
      try {
        const { svc } = makeService();
        const settled = await Promise.allSettled([
          svc.activate(seed.kgId, seed.discountId),
          svc.activate(seed.kgId, seed.discountId),
        ]);
        const fulfilled = settled.filter((r) => r.status === 'fulfilled');
        const rejected = settled.filter((r) => r.status === 'rejected');
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        const rejectedReason = (rejected[0] as PromiseRejectedResult).reason;
        expect(rejectedReason).toBeInstanceOf(CustomDiscountStatusInvalidError);
        const status = await readStatus(seed.kgId, seed.discountId);
        expect(status).toBe('active');
      } finally {
        await seed.cleanup();
      }
    });
  },
);
