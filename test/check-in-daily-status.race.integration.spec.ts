/**
 * Concurrent check-in vs explicit-status race on child_daily_status.
 *
 * Self-skips when `INTEGRATION_DB !== '1'` so `npm test` stays green on
 * machines without a configured tenant DB. Run with:
 *
 *   INTEGRATION_DB=1 DATABASE_USERNAME=shyraq_app DATABASE_PASSWORD=shyraq_app \
 *   npm test -- --testPathPattern check-in-daily-status.race.integration
 *
 * What this guards: AttendanceService.checkIn step 3 used to do
 *   const existing = await dailyStatusRepo.findByChildAndDate(...);
 *   if (existing.markPresent(staff, clock)) save(existing);
 *
 * Between the read and the unconditional save, a parent or admin can flip
 * the row to `sick` / `on_vacation` via setDailyStatus → the save
 * overwrites the explicit status with `present`.
 *
 * Fix: ChildDailyStatusRepository.updatePresentIfAbsentOrLate runs an
 *   UPDATE child_daily_status
 *   SET status='present', set_by=..., updated_at=...
 *   WHERE child_id=$ AND date=$ AND status IN ('absent', 'late')
 *
 * `affected = 0` means a concurrent setter already moved the row to a
 * non-promotable status; service surfaces that row as-is, no overwrite.
 *
 * The spec exercises the primitive directly:
 *   - Pre-set `sick` → call updatePresentIfAbsentOrLate → must NOT overwrite.
 *   - Pre-set `absent` → call updatePresentIfAbsentOrLate → MUST flip to present.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { ChildDailyStatusTypeOrmEntity } from '@/modules/attendance/infrastructure/persistence/relational/entities/child-daily-status.typeorm.entity';
import { ChildDailyStatusRelationalRepository } from '@/modules/attendance/infrastructure/persistence/relational/repositories/child-daily-status.relational.repository';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

describeIntegration(
  'ChildDailyStatusRepository.updatePresentIfAbsentOrLate — concurrent explicit-status race',
  () => {
    jest.setTimeout(60_000);

    let dataSource: DataSource;
    let kgId: string;
    let childId: string;
    let staffId: string;
    const isoDate = '2026-05-04';

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
        entities: [ChildDailyStatusTypeOrmEntity],
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
      childId = randomUUID();
      staffId = randomUUID();
      const slug = `cds-race-${kgId.slice(0, 8)}`;

      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(
          `INSERT INTO kindergartens (id, name, slug, is_active)
           VALUES ($1, 'CDS Race KG', $2, true)`,
          [kgId, slug],
        );
        await m.query(
          `INSERT INTO users (id, phone, full_name) VALUES ($1, $2, 'S')`,
          [randomUUID(), `+770111${kgId.slice(0, 5).replace(/[^0-9]/g, '0')}`],
        );
        await m.query(
          `INSERT INTO children (id, kindergarten_id, full_name, date_of_birth, status)
           VALUES ($1, $2, 'CDS Child', '2020-01-01', 'active')`,
          [childId, kgId],
        );
      });
    });

    afterEach(async () => {
      if (!dataSource?.isInitialized) return;
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(
          `DELETE FROM child_daily_status WHERE kindergarten_id = $1`,
          [kgId],
        );
        await m.query(`DELETE FROM children WHERE kindergarten_id = $1`, [
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

    async function seedDailyStatus(status: string): Promise<void> {
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(
          `INSERT INTO child_daily_status
             (id, kindergarten_id, child_id, date, status, set_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, NULL, NOW())`,
          [randomUUID(), kgId, childId, isoDate, status],
        );
      });
    }

    it('does NOT overwrite an explicitly set sick status (updated=false, current.status=sick)', async () => {
      await seedDailyStatus('sick');
      const repo = new ChildDailyStatusRelationalRepository(
        dataSource.getRepository(ChildDailyStatusTypeOrmEntity),
      );
      const out = await runInTenantTx(() =>
        repo.updatePresentIfAbsentOrLate(
          kgId,
          childId,
          isoDate,
          staffId,
          new Date(),
        ),
      );
      expect(out.updated).toBe(false);
      expect(out.current).not.toBeNull();
      expect(out.current!.status.value).toBe('sick');

      // DB invariant: row stayed sick.
      const rows = (await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        return m.query(
          `SELECT status FROM child_daily_status WHERE child_id = $1 AND date = $2`,
          [childId, isoDate],
        );
      })) as Array<{ status: string }>;
      expect(rows[0].status).toBe('sick');
    });

    it('flips an absent row to present (updated=true)', async () => {
      await seedDailyStatus('absent');
      const repo = new ChildDailyStatusRelationalRepository(
        dataSource.getRepository(ChildDailyStatusTypeOrmEntity),
      );
      const out = await runInTenantTx(() =>
        repo.updatePresentIfAbsentOrLate(
          kgId,
          childId,
          isoDate,
          staffId,
          new Date(),
        ),
      );
      expect(out.updated).toBe(true);
      expect(out.current).not.toBeNull();
      expect(out.current!.status.value).toBe('present');
    });
  },
);
