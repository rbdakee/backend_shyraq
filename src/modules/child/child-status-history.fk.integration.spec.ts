/**
 * B22a T13 M2 (codex) — composite FK on `child_status_history`.
 *
 * Self-skips when `INTEGRATION_DB !== '1'`. Run with:
 *
 *   $env:DATABASE_PORT='55432'; $env:DATABASE_USERNAME='shyraq';
 *   $env:DATABASE_PASSWORD='shyraq'; $env:INTEGRATION_DB='1';
 *   npm test -- --testPathPatterns='child-status-history.fk'
 *
 * After migration `1778633200000-B22ChildStatusHistoryFkFix`, the table
 * declares
 *
 *   FK (child_id, kindergarten_id) REFERENCES children(id, kindergarten_id)
 *
 * which makes a tenant-mismatched audit row physically impossible at the
 * DB boundary even when `bypass_rls=true`. This spec inserts a row whose
 * `kindergarten_id` is KG-A but whose `child_id` belongs to KG-B and
 * expects the INSERT to fail with PG `23503` (foreign_key_violation).
 *
 * Uses the migration-superuser role (`DATABASE_USERNAME=shyraq`) so the
 * INSERT can attempt to bypass RLS and reach the FK check.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

describeIntegration(
  'B22a T13 M2 child_status_history — composite FK rejects cross-tenant rows',
  () => {
    jest.setTimeout(60_000);

    let dataSource: DataSource;
    let kgA: string;
    let kgB: string;
    let userA: string;
    let childB: string;

    beforeAll(async () => {
      dataSource = new DataSource({
        type: 'postgres',
        host: process.env.DATABASE_HOST ?? 'localhost',
        port: process.env.DATABASE_PORT
          ? parseInt(process.env.DATABASE_PORT, 10)
          : 5432,
        username: process.env.DATABASE_USERNAME ?? 'shyraq',
        password: process.env.DATABASE_PASSWORD ?? 'shyraq',
        database: process.env.DATABASE_NAME ?? 'shyraq',
        synchronize: false,
        logging: false,
      });
      await dataSource.initialize();

      kgA = randomUUID();
      kgB = randomUUID();
      userA = randomUUID();
      childB = randomUUID();

      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(
          `INSERT INTO kindergartens (id, name, slug)
             VALUES ($1, 'KG-A', $3), ($2, 'KG-B', $4)`,
          [
            kgA,
            kgB,
            `csh-fk-a-${kgA.slice(0, 8)}`,
            `csh-fk-b-${kgB.slice(0, 8)}`,
          ],
        );
        await m.query(
          `INSERT INTO users (id, phone, full_name)
             VALUES ($1, $2, 'A')`,
          [userA, `+770000${kgA.slice(0, 6)}`],
        );
        await m.query(
          `INSERT INTO children
             (id, kindergarten_id, full_name, date_of_birth, status)
           VALUES ($1, $2, 'BotaB', '2021-09-15', 'active')`,
          [childB, kgB],
        );
      });
    });

    afterAll(async () => {
      if (!dataSource?.isInitialized) return;
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(
          `DELETE FROM child_status_history WHERE kindergarten_id IN ($1, $2)`,
          [kgA, kgB],
        );
        await m.query(`DELETE FROM children WHERE id = $1`, [childB]);
        await m.query(`DELETE FROM users WHERE id = $1`, [userA]);
        await m.query(`DELETE FROM kindergartens WHERE id IN ($1, $2)`, [
          kgA,
          kgB,
        ]);
      });
      await dataSource.destroy();
    });

    it('rejects (kg_A, child_B) cross-tenant insert with foreign_key_violation (PG 23503)', async () => {
      const historyId = randomUUID();
      await expect(
        dataSource.transaction(async (m) => {
          await m.query(`SET LOCAL app.bypass_rls = 'true'`);
          await m.query(
            `INSERT INTO child_status_history
               (id, kindergarten_id, child_id, previous_status, new_status,
                previous_archive_reason, archive_reason,
                changed_by_user_id, changed_at)
             VALUES ($1, $2, $3, 'active', 'archived',
                     NULL, 'cross-tenant write', $4, now())`,
            [historyId, kgA, childB, userA],
          );
        }),
      ).rejects.toMatchObject({ code: '23503' });
    });

    it('accepts a tenant-consistent (kg_B, child_B) insert', async () => {
      const historyId = randomUUID();
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(
          `INSERT INTO child_status_history
             (id, kindergarten_id, child_id, previous_status, new_status,
              previous_archive_reason, archive_reason,
              changed_by_user_id, changed_at)
           VALUES ($1, $2, $3, 'active', 'archived',
                   NULL, 'tenant-consistent write', $4, now())`,
          [historyId, kgB, childB, userA],
        );
      });
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        const rows = (await m.query(
          `SELECT id FROM child_status_history WHERE id = $1`,
          [historyId],
        )) as Array<{ id: string }>;
        expect(rows).toHaveLength(1);
      });
    });
  },
);
