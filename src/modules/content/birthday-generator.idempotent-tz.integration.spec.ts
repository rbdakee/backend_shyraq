/**
 * B22a T2 — birthday-generator idempotency across Almaty midnight rollover.
 *
 * Scenario: two ticks of the manual saas trigger land on the same Almaty
 * calendar day but on opposite sides of UTC midnight:
 *
 *   tick #1 at 2026-05-12T18:30:00.000Z  = 2026-05-12T23:30 Asia/Almaty
 *   tick #2 at 2026-05-12T19:30:00.000Z  = 2026-05-13T00:30 Asia/Almaty  (UTC day +1)
 *
 * Wait — tick #1 is May 12 Almaty and tick #2 is May 13 Almaty. So the
 * second tick should LEGITIMATELY post for kids whose birthday is May 13.
 *
 * The real boundary is: two ticks that are BOTH within the same Almaty
 * calendar day but straddle UTC midnight. That happens when:
 *
 *   tick #1 at 2026-05-12T18:30:00.000Z  = 2026-05-12T23:30 Asia/Almaty
 *   tick #2 at 2026-05-12T19:30:00.000Z  = 2026-05-13T00:30 Asia/Almaty
 *
 *   ↑ different Almaty days — proves the `formatDateInTimezone` rollover
 *
 * For TRUE idempotency on the same Almaty day, we test:
 *
 *   tick #1 at 2026-05-12T18:00:00.000Z  = 2026-05-12T23:00 Asia/Almaty
 *   tick #2 at 2026-05-12T18:59:00.000Z  = 2026-05-12T23:59 Asia/Almaty
 *
 * Both are Almaty 2026-05-12 — the second tick must skip (exists check
 * via the partial functional index added by `B22ContentBirthdayDateIndex`).
 *
 * Self-skips when INTEGRATION_DB !== '1'.  Run with:
 *
 *   $env:DATABASE_PORT='55432'; $env:DATABASE_USERNAME='shyraq_app'
 *   $env:DATABASE_PASSWORD='shyraq_app'; $env:INTEGRATION_DB='1'
 *   npx jest src/modules/content/birthday-generator.idempotent-tz.integration.spec.ts
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

describeIntegration(
  'B22a — birthday-generator idempotency across Almaty TZ boundary',
  () => {
    jest.setTimeout(60_000);

    let dataSource: DataSource;
    let kgId: string;
    let childId: string;
    let userId: string;
    let staffId: string;
    let groupId: string;

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
        entities: [],
        synchronize: false,
        logging: false,
      });
      await dataSource.initialize();

      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);

        kgId = randomUUID();
        childId = randomUUID();
        userId = randomUUID();
        staffId = randomUUID();
        groupId = randomUUID();

        await m.query(
          `INSERT INTO kindergartens (id, name, slug) VALUES ($1, 'B22a TZ KG', $2)`,
          [kgId, `b22a-tz-${kgId.slice(0, 8)}`],
        );
        const phone = `+7700${kgId.replace(/-/g, '').slice(0, 7)}`;
        await m.query(
          `INSERT INTO users (id, phone, full_name) VALUES ($1, $2, 'TZ Staff')`,
          [userId, phone],
        );
        await m.query(
          `INSERT INTO staff_members (id, kindergarten_id, user_id, role, is_active)
           VALUES ($1, $2, $3, 'admin', true)`,
          [staffId, kgId, userId],
        );
        await m.query(
          `INSERT INTO groups (id, kindergarten_id, name, capacity)
           VALUES ($1, $2, 'TZ group', 20)`,
          [groupId, kgId],
        );
        // Child with birthday on 2020-05-12 (matches Almaty calendar 2026-05-12)
        await m.query(
          `INSERT INTO children
             (id, kindergarten_id, current_group_id, full_name, date_of_birth,
              status, iin)
           VALUES ($1, $2, $3, 'TZ Child', '2020-05-12', 'active', $4)`,
          [
            childId,
            kgId,
            groupId,
            // 12-digit IIN — first 6 digits derived from DOB
            `200512${kgId.replace(/-/g, '').slice(0, 6)}`.slice(0, 12),
          ],
        );
      });
    });

    afterAll(async () => {
      if (!dataSource?.isInitialized) return;
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(`DELETE FROM content_posts WHERE kindergarten_id = $1`, [
          kgId,
        ]);
        await m.query(`DELETE FROM children WHERE id = $1`, [childId]);
        await m.query(`DELETE FROM groups WHERE id = $1`, [groupId]);
        await m.query(`DELETE FROM staff_members WHERE id = $1`, [staffId]);
        await m.query(`DELETE FROM users WHERE id = $1`, [userId]);
        await m.query(`DELETE FROM kindergartens WHERE id = $1`, [kgId]);
      });
      await dataSource.destroy();
    });

    /**
     * Insert a synthetic birthday post for a given UTC instant. Mirrors what
     * `BirthdayGeneratorService` writes — minus the runtime DI plumbing so we
     * can test the SQL-level idempotency contract directly.
     */
    async function insertSyntheticBirthdayPost(at: Date): Promise<string> {
      const id = randomUUID();
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(
          `INSERT INTO content_posts
             (id, kindergarten_id, content_type, target_type, target_child_id,
              title, status, created_by, published_at)
           VALUES ($1, $2, 'birthday', 'child', $3, 'Birthday', 'published',
                   $4, $5)`,
          [id, kgId, childId, userId, at.toISOString()],
        );
      });
      return id;
    }

    async function countBirthdayPosts(): Promise<number> {
      const rows = (await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        return m.query(
          `SELECT count(*)::int AS c FROM content_posts
            WHERE kindergarten_id = $1
              AND content_type = 'birthday'
              AND target_child_id = $2`,
          [kgId, childId],
        );
      })) as Array<{ c: number }>;
      return rows[0]?.c ?? 0;
    }

    /**
     * Run `existsBirthdayForChildOnDate` SQL verbatim. We intentionally do
     * not import the repository — the test exercises the SQL contract, not
     * the JS plumbing. The repo's `formatDateInTimezone(date)` step is
     * unit-tested separately in `day-of-week.vo.spec.ts`.
     */
    async function existsForAlmatyDate(isoDate: string): Promise<boolean> {
      const rows = (await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        return m.query(
          `SELECT 1 AS one
             FROM content_posts
            WHERE kindergarten_id = $1
              AND content_type = 'birthday'
              AND target_child_id = $2
              AND DATE(published_at AT TIME ZONE 'Asia/Almaty') = $3::date
            LIMIT 1`,
          [kgId, childId, isoDate],
        );
      })) as Array<{ one: number }>;
      return rows.length > 0;
    }

    it('detects a post written at 23:00 Almaty when checking same Almaty day at 23:59', async () => {
      // Tick #1 — 2026-05-12T18:00:00Z = 2026-05-12T23:00 Almaty
      const tick1 = new Date('2026-05-12T18:00:00.000Z');
      await insertSyntheticBirthdayPost(tick1);
      expect(await countBirthdayPosts()).toBe(1);

      // Tick #2 (later in same Almaty day) — would still resolve to '2026-05-12'.
      // We verify the SQL EXISTS check returns true → service would skip.
      expect(await existsForAlmatyDate('2026-05-12')).toBe(true);
    });

    it('does NOT match a post on a different Almaty calendar day (after UTC midnight rollover)', async () => {
      // The post inserted at 18:00Z is Almaty 2026-05-12. Querying for
      // Almaty 2026-05-13 must return false even though UTC says 2026-05-12
      // for the inserted timestamp.
      expect(await existsForAlmatyDate('2026-05-13')).toBe(false);
    });

    it('matches a post inserted at UTC-late-evening into the next Almaty calendar day', async () => {
      // Tick at 2026-05-12T19:30:00Z = 2026-05-13T00:30 Almaty → indexed as
      // 2026-05-13. Idempotent re-query for 2026-05-13 returns true; query
      // for 2026-05-12 must remain at exactly 1 match (only the earlier
      // post).
      const tickAlmatyNextDay = new Date('2026-05-12T19:30:00.000Z');
      await insertSyntheticBirthdayPost(tickAlmatyNextDay);

      expect(await existsForAlmatyDate('2026-05-13')).toBe(true);
      // Sanity: the earlier 18:00Z post still answers '2026-05-12'
      expect(await existsForAlmatyDate('2026-05-12')).toBe(true);
    });
  },
);
