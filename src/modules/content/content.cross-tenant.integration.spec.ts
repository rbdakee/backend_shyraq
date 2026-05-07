/**
 * B17 cross-tenant phantom-row integration spec — content_posts + group_stories.
 *
 * Seeds rows scoped to KG-A, then opens tenant-scoped TXs for KG-B and
 * asserts that:
 *   1. SELECT returns 0 rows (RLS read isolation).
 *   2. UPDATE affects 0 rows (RLS write isolation).
 *   3. cross-table: group_stories seeded in KG-A invisible from KG-B context.
 *   4. bypass_rls=true context sees both KG-A rows.
 *   5. FORCE RLS: with no GUC set at all, SELECT must return 0 rows, confirming
 *      the FORCE clause is effective for the shyraq_app (NOSUPERUSER NOBYPASSRLS) role.
 *
 * Self-skips when INTEGRATION_DB !== '1'.  Run with:
 *
 *   $env:DATABASE_PORT='55432'; $env:DATABASE_USERNAME='shyraq_app'
 *   $env:DATABASE_PASSWORD='shyraq_app'; $env:INTEGRATION_DB='1'
 *   npx jest src/modules/content/content.cross-tenant.integration.spec.ts
 */
import 'reflect-metadata';
import { ExecutionContext } from '@nestjs/common';
import { defer, lastValueFrom } from 'rxjs';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { tenantStorage } from '@/database/tenant-storage';
import { TenantContextInterceptor } from '@/common/interceptors/tenant-context.interceptor';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

describeIntegration(
  'B17 content_posts + group_stories — cross-tenant phantom isolation (RLS)',
  () => {
    jest.setTimeout(60_000);

    let dataSource: DataSource;

    // KG identifiers
    let kgA: string;
    let kgB: string;

    // KG-A supporting rows
    let userA: string;
    let staffA: string;
    let groupA: string;

    // KG-A content rows (the ones we test isolation on)
    let postA: string;
    let storyA: string;

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

      // ── Seed KG-A rows (all under bypass_rls) ─────────────────────────────
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);

        kgA = randomUUID();
        kgB = randomUUID();
        userA = randomUUID();
        staffA = randomUUID();
        groupA = randomUUID();
        postA = randomUUID();
        storyA = randomUUID();

        // Kindergartens
        await m.query(
          `INSERT INTO kindergartens (id, name, slug) VALUES ($1, 'Content KG-A', $2)`,
          [kgA, `content-kg-a-${kgA.slice(0, 8)}`],
        );
        await m.query(
          `INSERT INTO kindergartens (id, name, slug) VALUES ($1, 'Content KG-B', $2)`,
          [kgB, `content-kg-b-${kgB.slice(0, 8)}`],
        );

        // User + staff member for KG-A
        const phoneA = `+7700${kgA.replace(/-/g, '').slice(0, 7)}`;
        await m.query(
          `INSERT INTO users (id, phone, full_name) VALUES ($1, $2, 'Content Staff A')`,
          [userA, phoneA],
        );
        await m.query(
          `INSERT INTO staff_members (id, kindergarten_id, user_id, role, is_active)
           VALUES ($1, $2, $3, 'admin', true)`,
          [staffA, kgA, userA],
        );

        // Group in KG-A (needed for group_stories FK)
        // capacity has NOT NULL in DB (no column default despite dbml showing default:20)
        await m.query(
          `INSERT INTO groups (id, kindergarten_id, name, capacity) VALUES ($1, $2, 'Group A', 20)`,
          [groupA, kgA],
        );

        // content_posts row in KG-A (target_type='all' → group/child FKs NULL)
        await m.query(
          `INSERT INTO content_posts
             (id, kindergarten_id, content_type, target_type, title, status, created_by)
           VALUES ($1, $2, 'news', 'all', 'Test news KG-A', 'published', $3)`,
          [postA, kgA, userA],
        );

        // group_stories row in KG-A
        await m.query(
          `INSERT INTO group_stories
             (id, kindergarten_id, group_id, created_by, media_url, media_type, expires_at)
           VALUES ($1, $2, $3, $4, 'https://cdn.example.com/story-a.jpg', 'image',
                   now() + interval '24 hours')`,
          [storyA, kgA, groupA, userA],
        );
      });
    });

    afterAll(async () => {
      if (!dataSource?.isInitialized) return;
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(`DELETE FROM group_stories  WHERE id = $1`, [storyA]);
        await m.query(`DELETE FROM content_posts  WHERE id = $1`, [postA]);
        await m.query(`DELETE FROM groups         WHERE id = $1`, [groupA]);
        await m.query(`DELETE FROM staff_members  WHERE id = $1`, [staffA]);
        await m.query(`DELETE FROM users          WHERE id = $1`, [userA]);
        await m.query(`DELETE FROM kindergartens WHERE id IN ($1, $2)`, [
          kgA,
          kgB,
        ]);
      });
      await dataSource.destroy();
    });

    function makeCtx(req: Record<string, unknown>): ExecutionContext {
      return {
        getType: () => 'http',
        switchToHttp: () => ({ getRequest: () => req }),
      } as unknown as ExecutionContext;
    }

    /** Run a raw query inside a KG-B scoped tenant TX via TenantContextInterceptor. */
    async function readRowsAsKgB(
      sql: string,
      params: unknown[],
    ): Promise<Array<Record<string, unknown>>> {
      const interceptor = new TenantContextInterceptor(dataSource);
      const next = {
        handle: () =>
          defer(async () => {
            const ctx = tenantStorage.getStore();
            return ctx!.entityManager!.query(sql, params);
          }),
      };
      return (await lastValueFrom(
        interceptor.intercept(
          makeCtx({ tenant: { kgId: kgB, bypass: false } }),
          next,
        ),
      )) as Array<Record<string, unknown>>;
    }

    // ── Test 1: RLS read isolation — content_posts ────────────────────────────

    it('content_posts: KG-B scope returns zero rows for KG-A data', async () => {
      const rows = await readRowsAsKgB(
        `SELECT id FROM content_posts WHERE id = $1`,
        [postA],
      );
      expect(rows).toHaveLength(0);
    });

    // ── Test 2: RLS write isolation — UPDATE on KG-A content_posts from KG-B ──

    it('content_posts: UPDATE from KG-B context does not affect KG-A row', async () => {
      const interceptor = new TenantContextInterceptor(dataSource);
      let affectedRows = -1;

      const next = {
        handle: () =>
          defer(async () => {
            const ctx = tenantStorage.getStore();
            // Attempt to change status of a KG-A post from a KG-B session
            const result: [unknown[], number] =
              (await ctx!.entityManager!.query(
                `UPDATE content_posts SET status = 'draft' WHERE id = $1`,
                [postA],
              )) as [unknown[], number];
            affectedRows = Array.isArray(result) ? (result[1] ?? 0) : 0;
            return affectedRows;
          }),
      };

      await lastValueFrom(
        interceptor.intercept(
          makeCtx({ tenant: { kgId: kgB, bypass: false } }),
          next,
        ),
      );

      // RLS must have blocked the UPDATE — 0 rows affected
      expect(affectedRows).toBe(0);

      // Confirm the row is still in 'published' state via bypass context
      const rows = await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        return m.query(`SELECT status FROM content_posts WHERE id = $1`, [
          postA,
        ]);
      });
      const status = (rows as Array<{ status: string }>)[0]?.status;
      expect(status).toBe('published');
    });

    // ── Test 3: RLS read isolation — group_stories ────────────────────────────

    it('group_stories: KG-B scope returns zero rows for KG-A data', async () => {
      const rows = await readRowsAsKgB(
        `SELECT id FROM group_stories WHERE id = $1`,
        [storyA],
      );
      expect(rows).toHaveLength(0);
    });

    // ── Test 4: RLS write isolation — UPDATE on KG-A group_stories from KG-B ──

    it('group_stories: UPDATE from KG-B context does not affect KG-A row', async () => {
      const interceptor = new TenantContextInterceptor(dataSource);
      let affectedRows = -1;

      const next = {
        handle: () =>
          defer(async () => {
            const ctx = tenantStorage.getStore();
            const result: [unknown[], number] =
              (await ctx!.entityManager!.query(
                `UPDATE group_stories SET views = 999 WHERE id = $1`,
                [storyA],
              )) as [unknown[], number];
            affectedRows = Array.isArray(result) ? (result[1] ?? 0) : 0;
            return affectedRows;
          }),
      };

      await lastValueFrom(
        interceptor.intercept(
          makeCtx({ tenant: { kgId: kgB, bypass: false } }),
          next,
        ),
      );

      // RLS must have blocked the UPDATE — 0 rows affected
      expect(affectedRows).toBe(0);

      // Confirm views is still 0 via bypass context
      const rows = await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        return m.query(`SELECT views FROM group_stories WHERE id = $1`, [
          storyA,
        ]);
      });
      const views = (rows as Array<{ views: number | string }>)[0]?.views;
      expect(Number(views)).toBe(0);
    });

    // ── Test 5: bypass_rls=true exposes KG-A rows ─────────────────────────────

    it('bypass=true exposes both content_posts and group_stories rows', async () => {
      const interceptor = new TenantContextInterceptor(dataSource);
      const next = {
        handle: () =>
          defer(async () => {
            const ctx = tenantStorage.getStore();
            const mgr = ctx!.entityManager!;
            const [posts, stories] = await Promise.all([
              mgr.query(`SELECT id FROM content_posts  WHERE id = $1`, [postA]),
              mgr.query(`SELECT id FROM group_stories  WHERE id = $1`, [
                storyA,
              ]),
            ]);
            return { posts, stories };
          }),
      };
      const result = (await lastValueFrom(
        interceptor.intercept(
          makeCtx({ tenant: { kgId: null, bypass: true } }),
          next,
        ),
      )) as { posts: Array<unknown>; stories: Array<unknown> };

      expect(result.posts).toHaveLength(1);
      expect(result.stories).toHaveLength(1);
    });

    // ── Test 6: KG-A scope sees its own rows ──────────────────────────────────

    it('content_posts: KG-A scope returns its own row', async () => {
      const interceptor = new TenantContextInterceptor(dataSource);
      const next = {
        handle: () =>
          defer(async () => {
            const ctx = tenantStorage.getStore();
            return ctx!.entityManager!.query(
              `SELECT id FROM content_posts WHERE id = $1`,
              [postA],
            );
          }),
      };
      const rows = (await lastValueFrom(
        interceptor.intercept(
          makeCtx({ tenant: { kgId: kgA, bypass: false } }),
          next,
        ),
      )) as Array<unknown>;
      expect(rows).toHaveLength(1);
    });

    it('group_stories: KG-A scope returns its own row', async () => {
      const interceptor = new TenantContextInterceptor(dataSource);
      const next = {
        handle: () =>
          defer(async () => {
            const ctx = tenantStorage.getStore();
            return ctx!.entityManager!.query(
              `SELECT id FROM group_stories WHERE id = $1`,
              [storyA],
            );
          }),
      };
      const rows = (await lastValueFrom(
        interceptor.intercept(
          makeCtx({ tenant: { kgId: kgA, bypass: false } }),
          next,
        ),
      )) as Array<unknown>;
      expect(rows).toHaveLength(1);
    });

    // ── Test 7: FORCE RLS — no GUC set → 0 rows ───────────────────────────────
    //
    // When neither app.kindergarten_id nor app.bypass_rls is set in the session,
    // FORCE ROW LEVEL SECURITY must still restrict access for the shyraq_app
    // NOSUPERUSER/NOBYPASSRLS role (no GUC → nullif(…,'') returns NULL → policy
    // evaluates to false, zero rows returned).

    it('content_posts: FORCE RLS — no GUC set returns zero rows', async () => {
      const rows = await dataSource.transaction(async (m) => {
        // Deliberately do NOT set app.kindergarten_id or app.bypass_rls
        return m.query(`SELECT id FROM content_posts WHERE id = $1`, [postA]);
      });
      expect(rows as Array<unknown>).toHaveLength(0);
    });

    it('group_stories: FORCE RLS — no GUC set returns zero rows', async () => {
      const rows = await dataSource.transaction(async (m) => {
        // Deliberately do NOT set app.kindergarten_id or app.bypass_rls
        return m.query(`SELECT id FROM group_stories WHERE id = $1`, [storyA]);
      });
      expect(rows as Array<unknown>).toHaveLength(0);
    });
  },
);
