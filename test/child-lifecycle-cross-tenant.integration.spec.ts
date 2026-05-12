/**
 * B21 T1 — cross-tenant phantom row check for child lifecycle (archive).
 *
 * Self-skips when `INTEGRATION_DB !== '1'` so `npm test` stays green on
 * machines without a configured DB. Run with:
 *
 *   INTEGRATION_DB=1 DATABASE_HOST=localhost DATABASE_PORT=55432 \
 *   DATABASE_USERNAME=shyraq_app DATABASE_PASSWORD=shyraq_app \
 *   DATABASE_NAME=shyraq \
 *   npx jest --config ./test/jest-integration.json \
 *     --testPathPatterns child-lifecycle-cross-tenant
 *
 * What this guards:
 *
 *   1. Cross-tenant archive isolation — RLS must prevent kg_B from reading
 *      an archived child that belongs to kg_A, even when the query filters
 *      explicitly on `archived_at IS NOT NULL` (simulating the new
 *      idx_children_status_archived_at index path used in billing processors).
 *
 *   2. archived_at filter phantom — a query scoped to kg_B that filters
 *      WHERE status='archived' AND archived_at IS NOT NULL must return
 *      zero rows for children owned by kg_A.
 *
 * Pre-work finding (B21 T1):
 *   - `archived_at` and `archive_reason` columns already exist in `children`
 *     (added by P5 migration ChildrenAndGuardians1777593604000).
 *   - B21Lifecycle1778546628246 adds the composite index
 *     (kindergarten_id, status, archived_at) — these tests verify the RLS
 *     invariant that the index enables safely.
 *
 * Setup:
 *   - Two separate kindergartens (kg_A, kg_B) in beforeEach.
 *   - One archived child in kg_A (status='archived', archived_at set).
 *   - One active child in kg_B (to confirm kg_B's context works normally).
 *   - All queries use runtime role (shyraq_app, NOSUPERUSER NOBYPASSRLS).
 *   - Cleanup via DELETE in afterEach (runtime role has DELETE, not TRUNCATE).
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

describeIntegration(
  'Children RLS — cross-tenant phantom row isolation (B21 archive lifecycle)',
  () => {
    jest.setTimeout(60_000);

    let dataSource: DataSource;

    /** kg_A owns the archived child */
    let kgAId: string;
    /** kg_B is the "attacker" tenant — should never see kg_A data */
    let kgBId: string;

    let archivedChildId: string;
    let activeChildInKgBId: string;

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
        // No entities needed — using raw SQL to avoid relation resolution.
        entities: [],
        synchronize: false,
        logging: false,
        poolSize: 5,
      });
      await dataSource.initialize();
    });

    afterAll(async () => {
      if (!dataSource?.isInitialized) return;
      await dataSource.destroy();
    });

    beforeEach(async () => {
      kgAId = randomUUID();
      kgBId = randomUUID();
      archivedChildId = randomUUID();
      activeChildInKgBId = randomUUID();

      const slugA = `b21-kg-a-${kgAId.slice(0, 8)}`;
      const slugB = `b21-kg-b-${kgBId.slice(0, 8)}`;

      // Seed both kindergartens + one archived child in kg_A
      // + one active child in kg_B. Use bypass_rls because FORCE RLS
      // applies to the owner role too; we need cross-tenant INSERTs in setup.
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);

        await m.query(
          `INSERT INTO kindergartens (id, name, slug, is_active)
           VALUES ($1, 'B21 KG-A', $2, true)`,
          [kgAId, slugA],
        );
        await m.query(
          `INSERT INTO kindergartens (id, name, slug, is_active)
           VALUES ($1, 'B21 KG-B', $2, true)`,
          [kgBId, slugB],
        );

        // Archived child in kg_A.
        await m.query(
          `INSERT INTO children
             (id, kindergarten_id, full_name, date_of_birth, status,
              archived_at, archive_reason)
           VALUES ($1, $2, 'Archived Child KGA', '2019-06-15', 'archived',
                   now(), 'B21 test archive')`,
          [archivedChildId, kgAId],
        );

        // Active child in kg_B (sanity: kg_B context can see its own rows).
        await m.query(
          `INSERT INTO children
             (id, kindergarten_id, full_name, date_of_birth, status)
           VALUES ($1, $2, 'Active Child KGB', '2020-03-01', 'active')`,
          [activeChildInKgBId, kgBId],
        );
      });
    });

    afterEach(async () => {
      if (!dataSource?.isInitialized) return;
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(`DELETE FROM children WHERE kindergarten_id = $1`, [
          kgAId,
        ]);
        await m.query(`DELETE FROM children WHERE kindergarten_id = $1`, [
          kgBId,
        ]);
        await m.query(`DELETE FROM kindergartens WHERE id = $1`, [kgAId]);
        await m.query(`DELETE FROM kindergartens WHERE id = $1`, [kgBId]);
      });
    });

    /**
     * Runs `fn` inside a TX scoped to `kgId` — mirrors the
     * TenantContextInterceptor pipeline (SET LOCAL + tenantStorage).
     * kgId is a validated v4 UUID from randomUUID() — no injection risk.
     */
    async function runInTenantTx<T>(
      kgId: string,
      fn: (manager: typeof dataSource.manager) => Promise<T>,
    ): Promise<T> {
      return dataSource.transaction(async (manager) => {
        await manager.query(`SET LOCAL app.kindergarten_id = '${kgId}'`);
        return tenantStorage.run(
          { kgId, bypass: false, entityManager: manager },
          () => fn(manager),
        );
      });
    }

    it('returns 0 rows when kg_B queries all children — cannot see kg_A archived child', async () => {
      const rows = await runInTenantTx(kgBId, async (m) => {
        return m.query(
          `SELECT id, kindergarten_id, status FROM children`,
        ) as Promise<
          Array<{ id: string; kindergarten_id: string; status: string }>
        >;
      });

      const kgARows = rows.filter((r) => r.kindergarten_id === kgAId);
      expect(kgARows).toHaveLength(0);

      // Sanity: kg_B's own active child IS visible.
      const kgBRows = rows.filter((r) => r.kindergarten_id === kgBId);
      expect(kgBRows).toHaveLength(1);
      expect(kgBRows[0].id).toBe(activeChildInKgBId);
    });

    it('returns 0 rows when kg_B queries archived children filtered on archived_at — phantom row blocked', async () => {
      // Exact filter shape used by billing/pro-rata processors for archived
      // children lookup — exercises the idx_children_status_archived_at path.
      const rows = await runInTenantTx(kgBId, async (m) => {
        return m.query(
          `SELECT id, kindergarten_id
           FROM children
           WHERE status = 'archived'
             AND archived_at IS NOT NULL`,
        ) as Promise<Array<{ id: string; kindergarten_id: string }>>;
      });

      expect(rows).toHaveLength(0);
    });

    it('returns 0 rows when kg_B queries by kg_A id directly — cross-tenant direct lookup blocked', async () => {
      const rows = await runInTenantTx(kgBId, async (m) => {
        return m.query(`SELECT id FROM children WHERE kindergarten_id = $1`, [
          kgAId,
        ]) as Promise<Array<{ id: string }>>;
      });

      expect(rows).toHaveLength(0);
    });

    it('kg_A context reads its own archived child with archived_at populated', async () => {
      const rows = await runInTenantTx(kgAId, async (m) => {
        return m.query(
          `SELECT id, status, archived_at, archive_reason
           FROM children
           WHERE id = $1`,
          [archivedChildId],
        ) as Promise<
          Array<{
            id: string;
            status: string;
            archived_at: string | null;
            archive_reason: string | null;
          }>
        >;
      });

      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('archived');
      expect(rows[0].archived_at).not.toBeNull();
      expect(rows[0].archive_reason).toBe('B21 test archive');
    });
  },
);
