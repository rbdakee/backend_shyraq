/**
 * B11 T7-5 HIGH#2 — concurrent one-time trusted_person claim race.
 *
 * Self-skips when `INTEGRATION_DB !== '1'` so `npm test` stays green
 * on machines without a configured tenant DB. Run with:
 *
 *   INTEGRATION_DB=1 DATABASE_USERNAME=shyraq_app DATABASE_PASSWORD=shyraq_app \
 *   npm test -- --testPathPattern pickup-trusted-person.race.integration
 *
 * What this guards: two pickup_requests bound to the SAME `is_one_time=true`
 * trusted_people row each call `TrustedPersonRepository.markUsed(id, now,
 * deactivate=true)` concurrently. The advisory lock that
 * PickupRequestService.validateOtp acquires is keyed on the
 * `pickup_request_id`, so two requests sharing a tp row do NOT serialize
 * against each other. The repo's UPDATE must therefore be self-guarded —
 * only ONE caller observes `affected = 1` (claim won), the other observes
 * `affected = 0` (claim lost). The guarded WHERE clause is
 * `WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL AND is_active = true`.
 *
 * The spec runs 5 concurrent markUsed(deactivate=true) calls inside their
 * own transactions. Post-conditions:
 *   - Exactly 1 caller resolves `true`.
 *   - 4 callers resolve `false`.
 *   - DB row ends up `is_active=false`, `used_at` non-null.
 *
 * The non-one-time branch is also exercised — multiple markUsed(deactivate=
 * false) calls all succeed (last-write wins on used_at), simulating the
 * audit-style "last pickup at" semantics for reusable trusted_people.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { TrustedPersonRelationalRepository } from '@/modules/pickup/infrastructure/persistence/relational/repositories/trusted-person.relational.repository';
import { TrustedPersonTypeOrmEntity } from '@/modules/pickup/infrastructure/persistence/relational/entities/trusted-person.typeorm.entity';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

describeIntegration(
  'TrustedPersonRepository.markUsed — concurrent claim race (T7-5 HIGH#2)',
  () => {
    jest.setTimeout(60_000);

    let dataSource: DataSource;
    let kgId: string;
    let childId: string;
    let parentUserId: string;
    let tpId: string;

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
        entities: [TrustedPersonTypeOrmEntity],
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
      parentUserId = randomUUID();
      tpId = randomUUID();

      const kgSlug = `tp-race-${kgId.slice(0, 8)}`;

      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(
          `INSERT INTO kindergartens (id, name, slug, is_active)
           VALUES ($1, 'TP Race KG', $2, true)`,
          [kgId, kgSlug],
        );
        await m.query(
          `INSERT INTO users (id, phone, full_name) VALUES ($1, $2, 'TP Parent')`,
          [parentUserId, `+7700${kgId.slice(0, 7).replace(/[^0-9]/g, '0')}`],
        );
        await m.query(
          `INSERT INTO children (id, kindergarten_id, full_name, date_of_birth, status)
           VALUES ($1, $2, 'TP Child', '2020-01-01', 'active')`,
          [childId, kgId],
        );
      });
    });

    afterEach(async () => {
      if (!dataSource?.isInitialized) return;
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(`DELETE FROM trusted_people WHERE kindergarten_id = $1`, [
          kgId,
        ]);
        await m.query(`DELETE FROM children WHERE kindergarten_id = $1`, [
          kgId,
        ]);
        await m.query(`DELETE FROM users WHERE id = $1`, [parentUserId]);
        await m.query(`DELETE FROM kindergartens WHERE id = $1`, [kgId]);
      });
    });

    /**
     * Runs `fn` inside a TX with the kg-id GUC set so RLS allows the
     * repo to operate as the runtime app role. Mirrors the
     * TenantContextInterceptor pipeline minus its NestJS wiring.
     */
    async function runInTenantTx<T>(fn: () => Promise<T>): Promise<T> {
      return dataSource.transaction(async (manager) => {
        // PG `SET LOCAL` does not support parameter binding — its
        // operand is a literal at parse time, not a value. Inline the
        // tenant uuid (already validated as a v4 UUID by randomUUID()
        // in beforeEach so SQL injection is not a concern in this
        // tenant-test context).
        await manager.query(`SET LOCAL app.kindergarten_id = '${kgId}'`);
        return tenantStorage.run(
          {
            kgId,
            bypass: false,
            entityManager: manager,
          },
          fn,
        );
      });
    }

    async function seedTrustedPerson(isOneTime: boolean): Promise<void> {
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(
          `INSERT INTO trusted_people
             (id, kindergarten_id, child_id, added_by_user_id,
              full_name, phone, relation, is_active, is_one_time)
           VALUES ($1, $2, $3, $4, 'Race Person', '+77011000001',
                   'aunt', true, $5)`,
          [tpId, kgId, childId, parentUserId, isOneTime],
        );
      });
    }

    it('serializes 5 concurrent markUsed(deactivate=true) on a one-time row — exactly one wins, four return false', async () => {
      await seedTrustedPerson(true);
      const repo = new TrustedPersonRelationalRepository(
        dataSource,
        dataSource.getRepository(TrustedPersonTypeOrmEntity),
      );

      const now = new Date();
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          runInTenantTx(() => repo.markUsed(tpId, now, true)),
        ),
      );

      const winners = results.filter((r) => r === true);
      const losers = results.filter((r) => r === false);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(4);

      // DB invariant: row is consumed (`is_active=false`, `used_at` set).
      const rows = (await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        return m.query(
          `SELECT is_active, used_at FROM trusted_people WHERE id = $1`,
          [tpId],
        );
      })) as Array<{ is_active: boolean; used_at: string | null }>;

      expect(rows).toHaveLength(1);
      expect(rows[0].is_active).toBe(false);
      expect(rows[0].used_at).not.toBeNull();
    });

    it('lets 5 concurrent markUsed(deactivate=false) all succeed on a non-one-time row (last-write wins on used_at)', async () => {
      await seedTrustedPerson(false);
      const repo = new TrustedPersonRelationalRepository(
        dataSource,
        dataSource.getRepository(TrustedPersonTypeOrmEntity),
      );

      const now = new Date();
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          runInTenantTx(() => repo.markUsed(tpId, now, false)),
        ),
      );

      // All 5 update the row (no `used_at IS NULL` guard on non-one-time).
      expect(results.every((r) => r === true)).toBe(true);

      const rows = (await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        return m.query(
          `SELECT is_active, used_at FROM trusted_people WHERE id = $1`,
          [tpId],
        );
      })) as Array<{ is_active: boolean; used_at: string | null }>;

      expect(rows).toHaveLength(1);
      // is_active stays true (deactivate=false branch); used_at non-null.
      expect(rows[0].is_active).toBe(true);
      expect(rows[0].used_at).not.toBeNull();
    });
  },
);
