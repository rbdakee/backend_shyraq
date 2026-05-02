/**
 * B11 T0 — verify that POST /auth/role/select works for the parent path.
 *
 * Pre-existing concern (IMPLEMENTATION_PLAN.md §5 Active, B10 T7 finding):
 *   selectRole for parent triggers a refresh-token RLS violation because no
 *   app.kindergarten_id GUC is set in the surrounding TX (no
 *   KindergartenScopeGuard on the endpoint). After B10 T7-2 follow-up
 *   (cbca0da), RefreshTokenRelationalRepository.create carries an else-branch
 *   that opens its own TX with SET LOCAL app.bypass_rls = true when no
 *   ambient tenant context is present. This test confirms the fix holds.
 *
 * Scenario:
 *   1. Super-admin creates two kindergartens (kg_A, kg_B).
 *   2. Same parent phone is the contact for an enrollment in each kg.
 *   3. Parent passes OTP — auto-approve fires for both pending-primary rows.
 *      assembleRoles sees 2 approved guardian entries -> pending_role_select: true.
 *   4. Parent calls POST /auth/role/select { kindergartenId: kg_A.id, role: parent }
 *      -> MUST return 200 + access_token + refresh_token (no 500 / 403).
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
    const auth = await otpLogin(adminPhone);
    return { kgId: body.kindergarten.id, adminToken: auth.access_token };
  }

  function extractCode(): string {
    const last = ctx.sms.lastSent;
    if (!last) throw new Error('no SMS captured');
    const m = /(\d{6})/.exec(last.message);
    if (!m) throw new Error('no 6-digit code in SMS message');
    return m[1];
  }

  async function otpLogin(phone: string): Promise<AuthBody> {
    ctx.sms.lastSent = null;
    await request(server)
      .post('/api/v1/auth/otp/request')
      .send({ phone })
      .expect(202);
    const code = extractCode();
    const res = await request(server)
      .post('/api/v1/auth/otp/verify')
      .send({ phone, code })
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

  it('issues access+refresh for parent path via selectRole when guardian in 2 kgs (Scenario P)', async () => {
    // Create two kindergartens.
    const a = await createKgWithAdmin('srp-a', '+77011130001');
    const b = await createKgWithAdmin('srp-b', '+77011130002');

    const parentPhone = '+77011140001';

    // Enroll parent phone as contact in kg_A — seeds pending_primary row.
    await runEnrollmentCardCreated(a.adminToken, {
      contactName: 'Parent P',
      contactPhone: parentPhone,
      childName: 'Child-A',
      childDob: '2021-08-15',
    });

    // Enroll same parent phone in kg_B — seeds another pending_primary row.
    await runEnrollmentCardCreated(b.adminToken, {
      contactName: 'Parent P',
      contactPhone: parentPhone,
      childName: 'Child-B',
      childDob: '2021-09-15',
    });

    // Parent OTP login — auto-approve fires for both pending-primary rows.
    // Two approved guardian entries -> pending_role_select: true, refresh_token: null.
    const initial = await otpLogin(parentPhone);
    expect(initial.pending_role_select).toBe(true);
    expect(initial.refresh_token).toBeNull();
    expect(initial.roles).toHaveLength(2);
    const kgIds = initial.roles.map((r) => r.kindergarten_id);
    expect(kgIds).toContain(a.kgId);
    expect(kgIds).toContain(b.kgId);

    // Parent selects kg_A — the path under test.
    // POST /auth/role/select has no KindergartenScopeGuard -> no ambient TX
    // -> RefreshTokenRelationalRepository.create uses else-branch (bypass_rls TX).
    // Without cbca0da this would fail with an RLS violation (500).
    const selectRes = await request(server)
      .post('/api/v1/auth/role/select')
      .set('Authorization', `Bearer ${initial.access_token}`)
      .send({ kindergartenId: a.kgId, role: 'parent' })
      .expect(200);

    const selected = selectRes.body as AuthBody;
    expect(selected.pending_role_select).toBe(false);
    expect(typeof selected.access_token).toBe('string');
    expect(selected.access_token.length).toBeGreaterThan(0);
    expect(selected.refresh_token).not.toBeNull();
    expect((selected.refresh_token as string).length).toBe(64);
    expect(selected.roles).toEqual([
      { role: 'parent', kindergarten_id: a.kgId, group_id: null },
    ]);

    // Verify the issued refresh token is rotatable (proves the row was inserted).
    const refreshRes = await request(server)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: selected.refresh_token })
      .expect(200);
    const refreshed = refreshRes.body as AuthBody;
    expect(typeof refreshed.access_token).toBe('string');
    expect(refreshed.refresh_token).not.toBeNull();
  });
});
