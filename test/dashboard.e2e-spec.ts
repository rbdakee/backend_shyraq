/**
 * B-DASH admin dashboard e2e — exercises the 3 read-only aggregate
 * endpoints over HTTP and proves cross-tenant isolation (RLS + explicit
 * kindergartenId), per DASHBOARD_BACKEND_PLAN §4 and CLAUDE.md §9 p.11.
 *
 * Endpoints under test:
 *   GET /api/v1/admin/dashboard/summary
 *   GET /api/v1/admin/dashboard/payments-overview?from=&to=
 *   GET /api/v1/admin/dashboard/attendance-today?group_id=&date=
 *
 * Scenarios:
 *   - 401 with no Bearer on every route.
 *   - 403 with a parent-role token (RolesGuard admin/reception).
 *   - 400 invalid_date_range when payments-overview to < from.
 *   - cross-tenant phantom-row: kg_B's rows never leak into kg_A's summary
 *     or attendance-today aggregate.
 *   - payments-overview returns the documented bucket + by_provider shape.
 *
 * `npm run test:e2e` runs maxWorkers:1 (FK-safe TRUNCATE between cases).
 */
import type { Server } from 'node:http';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createTestApp, flushRedis, TestApp, truncateAll } from './helpers/app';

const SUPER_ADMIN_EMAIL = 'super-dashboard@shyraq.test';
const SUPER_ADMIN_PASSWORD = 'admin12345';

interface CreatedKgResp {
  kindergarten: { id: string; slug: string };
  staff_member: { id: string; user_id: string };
  user: { id: string; phone: string };
}

describe('B-DASH admin dashboard (e2e)', () => {
  let ctx: TestApp;
  let server: Server;
  let saAccess: string;
  let jwtService: JwtService;
  let jwtSecret: string;

  async function mintAccess(opts: {
    sub: string;
    kindergartenId: string;
    role: string;
  }): Promise<string> {
    return jwtService.signAsync(
      {
        sub: opts.sub,
        role: opts.role,
        kindergarten_id: opts.kindergartenId,
        jti: randomUUID(),
      },
      { secret: jwtSecret, expiresIn: '1h' },
    );
  }

  async function seedSuperAdmin(): Promise<void> {
    const hash = await bcrypt.hash(SUPER_ADMIN_PASSWORD, 4);
    await ctx.dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      await m.query(
        `INSERT INTO saas_users (id, email, full_name, password_hash, role, is_active)
         VALUES ($1, $2, 'SA', $3, 'super_admin', true)`,
        [randomUUID(), SUPER_ADMIN_EMAIL, hash],
      );
    });
  }

  async function loginSuperAdmin(): Promise<string> {
    const res = await request(server)
      .post('/api/v1/saas/auth/login')
      .send({ email: SUPER_ADMIN_EMAIL, password: SUPER_ADMIN_PASSWORD })
      .expect(200);
    return res.body.access_token as string;
  }

  async function createKgWithAdmin(
    slug: string,
    phone: string,
  ): Promise<{ kgId: string; userId: string; adminToken: string }> {
    const res = await request(server)
      .post('/api/v1/saas/kindergartens')
      .set('Authorization', `Bearer ${saAccess}`)
      .send({
        name: 'Dashboard-Test KG',
        slug,
        admin: { full_name: 'Admin', phone },
      })
      .expect(201);
    const body = res.body as CreatedKgResp;
    const adminToken = await mintAccess({
      sub: body.user.id,
      kindergartenId: body.kindergarten.id,
      role: 'admin',
    });
    return { kgId: body.kindergarten.id, userId: body.user.id, adminToken };
  }

  async function seedActiveChildren(
    kgId: string,
    count: number,
  ): Promise<string[]> {
    const ids: string[] = [];
    await ctx.dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      for (let i = 0; i < count; i++) {
        const id = randomUUID();
        ids.push(id);
        await m.query(
          `INSERT INTO children
             (id, kindergarten_id, full_name, date_of_birth, status,
              created_at, updated_at)
           VALUES ($1, $2, $3, '2022-01-01', 'active', now(), now())`,
          [id, kgId, `Child-${i}`],
        );
      }
    });
    return ids;
  }

  async function seedEnrollments(
    kgId: string,
    count: number,
    status: string,
  ): Promise<void> {
    await ctx.dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      for (let i = 0; i < count; i++) {
        await m.query(
          `INSERT INTO enrollments
             (id, kindergarten_id, contact_name, contact_phone, status,
              status_changed_at, created_at, updated_at)
           VALUES ($1, $2, 'Lead', '+7700000000', $3, now(), now(), now())`,
          [randomUUID(), kgId, status],
        );
      }
    });
  }

  async function seedDailyStatus(
    kgId: string,
    childId: string,
    status: string,
    date: string,
  ): Promise<void> {
    await ctx.dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      await m.query(
        `INSERT INTO child_daily_status
           (id, kindergarten_id, child_id, date, status, updated_at)
         VALUES ($1, $2, $3, $4::date, $5, now())`,
        [randomUUID(), kgId, childId, date, status],
      );
    });
  }

  function almatyToday(): string {
    return new Date().toLocaleDateString('en-CA', {
      timeZone: 'Asia/Almaty',
    });
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.server;
    const config = ctx.app.get(ConfigService);
    jwtSecret = config.getOrThrow<string>('auth.jwtAccessSecret');
    jwtService = ctx.app.get(JwtService);
  });

  afterAll(async () => {
    await truncateAll(ctx.dataSource);
    await flushRedis(ctx.redis);
    await ctx.app.close();
  });

  beforeEach(async () => {
    await truncateAll(ctx.dataSource);
    await flushRedis(ctx.redis);
    await seedSuperAdmin();
    saAccess = await loginSuperAdmin();
  });

  // ── Auth ──────────────────────────────────────────────────────────────

  it('returns 401 without a Bearer on every dashboard route', async () => {
    await request(server).get('/api/v1/admin/dashboard/summary').expect(401);
    await request(server)
      .get(
        '/api/v1/admin/dashboard/payments-overview?from=2026-05-01&to=2026-05-31',
      )
      .expect(401);
    await request(server)
      .get('/api/v1/admin/dashboard/attendance-today')
      .expect(401);
  });

  it('returns 403 for a parent-role token (admin/reception only)', async () => {
    const a = await createKgWithAdmin('dash-403', '+77011140001');
    const parentToken = await mintAccess({
      sub: a.userId,
      kindergartenId: a.kgId,
      role: 'parent',
    });
    await request(server)
      .get('/api/v1/admin/dashboard/summary')
      .set('Authorization', `Bearer ${parentToken}`)
      .expect(403);
  });

  // ── Validation ────────────────────────────────────────────────────────

  it('returns 400 invalid_date_range when payments-overview to < from', async () => {
    const a = await createKgWithAdmin('dash-400', '+77011140002');
    const res = await request(server)
      .get('/api/v1/admin/dashboard/payments-overview')
      .query({ from: '2026-05-31', to: '2026-05-01' })
      .set('Authorization', `Bearer ${a.adminToken}`)
      .expect(400);
    expect(JSON.stringify(res.body)).toContain('invalid_date_range');
  });

  // ── Cross-tenant isolation ────────────────────────────────────────────

  it('does not leak kg_B rows into kg_A summary (RLS + explicit kgId)', async () => {
    const A = await createKgWithAdmin('dash-iso-a', '+77011140003');
    const B = await createKgWithAdmin('dash-iso-b', '+77011140004');

    await seedActiveChildren(A.kgId, 2);
    await seedActiveChildren(B.kgId, 9);
    await seedEnrollments(A.kgId, 1, 'new');
    await seedEnrollments(B.kgId, 5, 'in_processing');

    const res = await request(server)
      .get('/api/v1/admin/dashboard/summary')
      .set('Authorization', `Bearer ${A.adminToken}`)
      .expect(200);

    // kg_A sees only its own rows.
    expect(res.body.active_children).toBe(2);
    expect(res.body.enrollments_in_processing).toBe(1);
    // create-kg seeds exactly one admin staff per kg.
    expect(res.body.active_staff).toBe(1);
    // Numeric, integer-tenge money fields default to 0 with no billing rows.
    expect(res.body.invoices_overdue_amount).toBe(0);
    expect(res.body.mtd_revenue).toBe(0);
    expect(res.body.ytd_revenue).toBe(0);
  });

  it('aggregates attendance-today from daily-status and isolates by tenant', async () => {
    const A = await createKgWithAdmin('dash-att-a', '+77011140005');
    const B = await createKgWithAdmin('dash-att-b', '+77011140006');
    const [cA1, cA2, cA3] = await seedActiveChildren(A.kgId, 3);
    const [cB1] = await seedActiveChildren(B.kgId, 1);
    const today = almatyToday();

    await seedDailyStatus(A.kgId, cA1, 'sick', today);
    await seedDailyStatus(A.kgId, cA2, 'on_vacation', today);
    await seedDailyStatus(A.kgId, cA3, 'absent', today);
    // kg_B phantom row — must NOT count in kg_A's aggregate.
    await seedDailyStatus(B.kgId, cB1, 'sick', today);

    const res = await request(server)
      .get('/api/v1/admin/dashboard/attendance-today')
      .set('Authorization', `Bearer ${A.adminToken}`)
      .expect(200);

    expect(res.body).toEqual({
      in_kindergarten: 0,
      checked_out: 0,
      absent: 1,
      on_vacation: 1,
      sick: 1,
    });
  });

  // ── Payments-overview shape ───────────────────────────────────────────

  it('returns the documented payments-overview shape (buckets + by_provider)', async () => {
    const a = await createKgWithAdmin('dash-po', '+77011140007');
    const res = await request(server)
      .get('/api/v1/admin/dashboard/payments-overview')
      .query({ from: '2026-05-01', to: '2026-05-31' })
      .set('Authorization', `Bearer ${a.adminToken}`)
      .expect(200);

    for (const bucket of ['paid', 'pending', 'overdue', 'refunded'] as const) {
      expect(res.body[bucket]).toEqual({ count: 0, amount: 0 });
    }
    expect(Array.isArray(res.body.by_provider)).toBe(true);
    expect(res.body.by_provider).toHaveLength(0);
  });
});
