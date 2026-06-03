/**
 * B11 T0 — verify the multi-kg parent path under the app-aware auth contract.
 *
 * Contract (docs/endpoints.md §0.1): parents NEVER role-select. A parent who
 * is an approved guardian in 2+ kindergartens is issued an UNSCOPED
 * (kindergarten_id=null) access+refresh pair DIRECTLY from /auth/otp/verify
 * (pending_role_select:false, refresh_token non-null). The kg=null token then
 * fans out cross-tenant so GET /parent/children returns children from every kg.
 * The old /auth/role/select step for parents is obsolete by design.
 *
 * RLS-regression value preserved here (was the original point of this spec):
 *   - the unscoped refresh token must be rotatable (proves the row was actually
 *     inserted despite there being no ambient app.kindergarten_id GUC), and
 *   - the unscoped access token must fan out cross-tenant — GET /parent/children
 *     returns one child per kg.
 *
 * Scenario:
 *   1. Super-admin creates two kindergartens (kg_A, kg_B).
 *   2. Same parent phone is the contact for an enrollment in each kg.
 *   3. Parent passes OTP (app=parent) — auto-approve fires for both
 *      pending-primary rows. Two approved guardian entries in different kgs ->
 *      direct unscoped token (pending_role_select:false, refresh non-null).
 */
import type { Server } from 'node:http';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestApp, flushRedis, TestApp, truncateAll } from './helpers/app';

const SUPER_ADMIN_EMAIL = 'super-select-role-parent@shyraq.test';
const SUPER_ADMIN_PASSWORD = 'admin12345';

interface CreatedKgResp {
  kindergarten: { id: string; slug: string };
  staff_member: { id: string; user_id: string };
  user: { id: string; phone: string };
}

interface AuthBody {
  access_token: string;
  refresh_token: string | null;
  token_type: string;
  expires_in: number;
  pending_role_select: boolean;
  roles: {
    role: string;
    kindergarten_id: string | null;
    group_id: string | null;
  }[];
  user: {
    id: string;
    phone: string;
    full_name: string;
  };
}

describe('B11 T0 — parent selectRole RLS regression (e2e)', () => {
  let ctx: TestApp;
  let server: Server;
  let saAccess: string;

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
    adminPhone: string,
  ): Promise<{ kgId: string; adminToken: string }> {
    const res = await request(server)
      .post('/api/v1/saas/kindergartens')
      .set('Authorization', `Bearer ${saAccess}`)
      .send({
        name: `SelectRole-Test-KG-${slug}`,
        slug,
        admin: { full_name: 'Admin', phone: adminPhone },
      })
      .expect(201);
    const body = res.body as CreatedKgResp;
    const auth = await otpLogin(adminPhone, 'admin');
    return { kgId: body.kindergarten.id, adminToken: auth.access_token };
  }

  function extractCode(): string {
    const last = ctx.sms.lastSent;
    if (!last) throw new Error('no SMS captured');
    const m = /(\d{6})/.exec(last.message);
    if (!m) throw new Error('no 6-digit code in SMS message');
    return m[1];
  }

  async function otpLogin(
    phone: string,
    app: 'parent' | 'staff' | 'admin' = 'parent',
  ): Promise<AuthBody> {
    ctx.sms.lastSent = null;
    await request(server)
      .post('/api/v1/auth/otp/request')
      .send({ phone, app })
      .expect(202);
    const code = extractCode();
    const res = await request(server)
      .post('/api/v1/auth/otp/verify')
      .send({ phone, code, app })
      .expect(200);
    return res.body as AuthBody;
  }

  async function runEnrollmentCardCreated(
    adminToken: string,
    args: {
      contactName: string;
      contactPhone: string;
      childName: string;
      childDob: string;
    },
  ): Promise<{ childId: string }> {
    const grp = await request(server)
      .post('/api/v1/groups')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: 'Aralar', capacity: 20 })
      .expect(201);

    const create = await request(server)
      .post('/api/v1/admin/enrollments')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        contactName: args.contactName,
        contactPhone: args.contactPhone,
        childName: args.childName,
        childDob: args.childDob,
      })
      .expect(201);

    await request(server)
      .post(`/api/v1/admin/enrollments/${create.body.id}/transition`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ toStatus: 'in_processing' })
      .expect(200);

    const card = await request(server)
      .post(`/api/v1/admin/enrollments/${create.body.id}/transition`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ toStatus: 'card_created', currentGroupId: grp.body.id })
      .expect(200);

    return { childId: card.body.enrollment.childId as string };
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.server;
  });

  afterAll(async () => {
    await truncateAll(ctx.dataSource);
    await flushRedis(ctx.redis);
    await ctx.app.close();
  });

  beforeEach(async () => {
    await truncateAll(ctx.dataSource);
    await flushRedis(ctx.redis);
    ctx.sms.lastSent = null;
    ctx.sms.log.length = 0;
    await seedSuperAdmin();
    saAccess = await loginSuperAdmin();
  });

  it('issues an unscoped access+refresh directly from verify for a parent who is guardian in 2 kgs (no role-select) (Scenario P)', async () => {
    // Create two kindergartens.
    const a = await createKgWithAdmin('srp-a', '+77011130001');
    const b = await createKgWithAdmin('srp-b', '+77011130002');

    const parentPhone = '+77011140001';

    // Enroll parent phone as contact in kg_A — seeds pending_primary row.
    const enrollA = await runEnrollmentCardCreated(a.adminToken, {
      contactName: 'Parent P',
      contactPhone: parentPhone,
      childName: 'Child-A',
      childDob: '2021-08-15',
    });

    // Enroll same parent phone in kg_B — seeds another pending_primary row.
    const enrollB = await runEnrollmentCardCreated(b.adminToken, {
      contactName: 'Parent P',
      contactPhone: parentPhone,
      childName: 'Child-B',
      childDob: '2021-09-15',
    });

    // Parent OTP login (app=parent) — auto-approve fires for both
    // pending-primary rows. Per the app-aware contract, a parent who is a
    // guardian in 2+ kgs gets an UNSCOPED token DIRECTLY from verify: no
    // role-select, refresh_token non-null. Both kg roles are reported so the
    // client knows the guardian spans multiple kindergartens.
    const initial = await otpLogin(parentPhone);
    expect(initial.pending_role_select).toBe(false);
    expect(initial.refresh_token).not.toBeNull();
    expect(initial.refresh_token as string).toMatch(/^[0-9a-f]{64}$/);
    expect(initial.roles).toHaveLength(2);
    const kgIds = initial.roles.map((r) => r.kindergarten_id);
    expect(kgIds).toContain(a.kgId);
    expect(kgIds).toContain(b.kgId);

    // RLS-regression (a): the unscoped refresh token is rotatable. There is no
    // ambient app.kindergarten_id GUC for a kg=null parent session, so the
    // refresh_tokens row must have been inserted via the bypass_rls branch —
    // a successful rotation (200 + new non-null refresh) proves that.
    const refreshRes = await request(server)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: initial.refresh_token })
      .expect(200);
    const refreshed = refreshRes.body as AuthBody;
    expect(typeof refreshed.access_token).toBe('string');
    expect(refreshed.refresh_token).not.toBeNull();

    // RLS-regression (b): the unscoped access token fans out cross-tenant —
    // GET /parent/children returns BOTH children (one per kg). This proves the
    // kg=null parent token escapes single-tenant scoping.
    const list = await request(server)
      .get('/api/v1/parent/children')
      .set('Authorization', `Bearer ${initial.access_token}`)
      .expect(200);
    expect(list.body).toHaveLength(2);
    const childIds = (list.body as Array<{ id: string }>).map((c) => c.id);
    expect(childIds).toContain(enrollA.childId);
    expect(childIds).toContain(enrollB.childId);
  });
});
