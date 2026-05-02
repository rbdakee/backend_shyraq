/**
 * B10 Identity QR - e2e scenarios A-K.
 *
 * Endpoints under test:
 *   GET  /api/v1/users/me/qr
 *   POST /api/v1/staff/qr/scan
 *   POST /api/v1/admin/qr/revoke-all/:userId
 *
 * Device-ID:
 *   /auth/otp/verify reads `X-Device-Id` and persists it onto the issued
 *   refresh_token row. The scan path calls hasActiveSessionForDevice() with
 *   strict equality, so passing the header at OTP-verify is sufficient — no
 *   post-hoc UPDATE is needed. (Pre-T7 the controller ignored the header,
 *   forcing an UPDATE workaround; that has been removed.)
 */
import { createHash, randomBytes } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { createTestApp, flushRedis, TestApp, truncateAll } from './helpers/app';

const SUPER_ADMIN_EMAIL = 'super-qr-e2e@shyraq.test';
const SUPER_ADMIN_PASSWORD = 'admin12345';
const STAFF_DEVICE_ID = 'staff-device-1';

interface AuthBody {
  access_token: string;
  refresh_token: string | null;
  pending_role_select: boolean;
  roles: {
    role: string;
    kindergarten_id: string | null;
    group_id: string | null;
  }[];
  user: { id: string; phone: string; full_name: string };
}

interface CreatedKgResp {
  kindergarten: { id: string; slug: string };
  staff_member: { id: string; user_id: string };
  user: { id: string; phone: string };
}

describe('B10 Identity QR (e2e)', () => {
  let ctx: TestApp;
  let server: Server;
  let saAccess: string;

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

  function extractCode(): string {
    const last = ctx.sms.lastSent;
    if (!last) throw new Error('no SMS captured');
    const m = /(\d{6})/.exec(last.message);
    if (!m) throw new Error('no 6-digit code in message');
    return m[1];
  }

  async function otpLogin(phone: string, deviceId?: string): Promise<AuthBody> {
    ctx.sms.lastSent = null;
    await request(server)
      .post('/api/v1/auth/otp/request')
      .send({ phone })
      .expect(202);
    const code = extractCode();
    const req2 = request(server)
      .post('/api/v1/auth/otp/verify')
      .send({ phone, code });
    if (deviceId) req2.set('X-Device-Id', deviceId);
    const res = await req2.expect(200);
    return res.body as AuthBody;
  }

  async function createKgWithAdmin(
    slug: string,
    phone: string,
    adminDeviceId?: string,
  ): Promise<{ kgId: string; adminUserId: string; adminToken: string }> {
    const res = await request(server)
      .post('/api/v1/saas/kindergartens')
      .set('Authorization', `Bearer ${saAccess}`)
      .send({
        name: `QR-Test KG ${slug}`,
        slug,
        admin: { full_name: 'Admin', phone },
      })
      .expect(201);
    const body = res.body as CreatedKgResp;
    const auth = await otpLogin(phone, adminDeviceId);
    return {
      kgId: body.kindergarten.id,
      adminUserId: body.user.id,
      adminToken: auth.access_token,
    };
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
      .send({ name: 'QR-Group', capacity: 20 })
      .expect(201);

    const enroll = await request(server)
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
      .post(`/api/v1/admin/enrollments/${enroll.body.id}/transition`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ toStatus: 'in_processing' })
      .expect(200);

    const card = await request(server)
      .post(`/api/v1/admin/enrollments/${enroll.body.id}/transition`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ toStatus: 'card_created', currentGroupId: grp.body.id })
      .expect(200);

    return { childId: card.body.enrollment.childId as string };
  }

  // ── A. First GET issues a fresh 32-hex token ──────────────────────────────

  it('issues a fresh 32-hex token with 24h expiresAt on first GET (Scenario A)', async () => {
    const parentAuth = await otpLogin('+77021110001');

    const res = await request(server)
      .get('/api/v1/users/me/qr')
      .set('Authorization', `Bearer ${parentAuth.access_token}`)
      .expect(200);

    expect(res.body.token).toMatch(/^[0-9a-f]{32}$/);
    const issuedMs = new Date(res.body.issuedAt as string).getTime();
    const expiresMs = new Date(res.body.expiresAt as string).getTime();
    expect((expiresMs - issuedMs) / 3_600_000).toBeCloseTo(24, 1);
  });

  // ── B. Re-GET issues a DIFFERENT token ────────────────────────────────────

  it('issues a DIFFERENT token on re-GET (no reuse design, Scenario B)', async () => {
    const parentAuth = await otpLogin('+77021110002');

    const r1 = await request(server)
      .get('/api/v1/users/me/qr')
      .set('Authorization', `Bearer ${parentAuth.access_token}`)
      .expect(200);

    const r2 = await request(server)
      .get('/api/v1/users/me/qr')
      .set('Authorization', `Bearer ${parentAuth.access_token}`)
      .expect(200);

    expect(r2.body.token).toMatch(/^[0-9a-f]{32}$/);
    expect(r2.body.token).not.toBe(r1.body.token);
  });

  // ── C. DB-level: previous row has revoked_at after re-GET ─────────────────

  it('stamps revoked_at on the old DB row after re-GET (Scenario C)', async () => {
    const parentAuth = await otpLogin('+77021110003');

    const r1 = await request(server)
      .get('/api/v1/users/me/qr')
      .set('Authorization', `Bearer ${parentAuth.access_token}`)
      .expect(200);
    const firstHash = createHash('sha256')
      .update(r1.body.token as string)
      .digest('hex');

    // Second GET triggers revoke of the first token row.
    await request(server)
      .get('/api/v1/users/me/qr')
      .set('Authorization', `Bearer ${parentAuth.access_token}`)
      .expect(200);

    const rows = (await ctx.dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      return m.query(
        `SELECT revoked_at FROM user_qr_tokens WHERE token_hash = $1`,
        [firstHash],
      );
    })) as Array<{ revoked_at: string | null }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].revoked_at).not.toBeNull();
  });

  // ── D. Staff scans valid parent token ─────────────────────────────────────

  it('returns 200 + user + linkedChildren + allowedActions on valid scan (Scenario D)', async () => {
    const a = await createKgWithAdmin('qr-d', '+77021120001');
    const parentPhone = '+77021110004';

    const enrollment = await runEnrollmentCardCreated(a.adminToken, {
      contactName: 'Parent D',
      contactPhone: parentPhone,
      childName: 'Child D',
      childDob: '2021-05-01',
    });

    // OTP-login auto-approves the pending primary guardian row.
    const parentAuth = await otpLogin(parentPhone);

    const qrRes = await request(server)
      .get('/api/v1/users/me/qr')
      .set('Authorization', `Bearer ${parentAuth.access_token}`)
      .expect(200);

    const staffAuth = await otpLogin('+77021120001', STAFF_DEVICE_ID);

    const scanRes = await request(server)
      .post('/api/v1/staff/qr/scan')
      .set('Authorization', `Bearer ${staffAuth.access_token}`)
      .set('X-Device-Id', STAFF_DEVICE_ID)
      .send({ token: qrRes.body.token })
      .expect(200);

    expect(scanRes.body.user.id).toBe(parentAuth.user.id);
    expect(scanRes.body.user.role).toBe('parent');
    expect(Array.isArray(scanRes.body.linkedChildren)).toBe(true);
    expect(scanRes.body.linkedChildren).toHaveLength(1);
    expect(scanRes.body.linkedChildren[0].id).toBe(enrollment.childId);
    // Enrollment creates primary guardian with can_pickup = true.
    expect(scanRes.body.allowedActions).toEqual(
      expect.arrayContaining(['check_in', 'check_out']),
    );
  });

  // ── E. Staff scans expired token → 410 qr_token_expired ──────────────────

  it('returns 410 qr_token_expired on expired token (Scenario E)', async () => {
    // KG creation seeds the staff user (admin role) used as the scanner below.
    await createKgWithAdmin('qr-e', '+77021120002');
    const parentAuth = await otpLogin('+77021110005');

    const qrRes = await request(server)
      .get('/api/v1/users/me/qr')
      .set('Authorization', `Bearer ${parentAuth.access_token}`)
      .expect(200);
    const tokenHash = createHash('sha256')
      .update(qrRes.body.token as string)
      .digest('hex');

    // Fast-forward expiry to the past via direct SQL.
    await ctx.dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      await m.query(
        `UPDATE user_qr_tokens
         SET expires_at = NOW() - INTERVAL '1 hour'
         WHERE token_hash = $1`,
        [tokenHash],
      );
    });

    const staffAuth = await otpLogin('+77021120002', STAFF_DEVICE_ID);

    const scanRes = await request(server)
      .post('/api/v1/staff/qr/scan')
      .set('Authorization', `Bearer ${staffAuth.access_token}`)
      .set('X-Device-Id', STAFF_DEVICE_ID)
      .send({ token: qrRes.body.token });

    expect(scanRes.status).toBe(410);
    expect(scanRes.body.error).toBe('qr_token_expired');
  });

  // ── F. Staff scans admin-revoked token → 410 qr_token_revoked ────────────

  it('returns 410 qr_token_revoked when admin revoked (DB-is-SoT, Scenario F)', async () => {
    const a = await createKgWithAdmin('qr-f', '+77021120003');
    const parentAuth = await otpLogin('+77021110006');

    const qrRes = await request(server)
      .get('/api/v1/users/me/qr')
      .set('Authorization', `Bearer ${parentAuth.access_token}`)
      .expect(200);
    const qrToken: string = qrRes.body.token as string;

    // Admin bulk-revokes. Redis cache entry is NOT cleared (admin has only
    // hashes, not plaintext). This tests the DB-recheck path that catches
    // revoked_at even when the Redis entry still exists.
    await request(server)
      .post(`/api/v1/admin/qr/revoke-all/${parentAuth.user.id}`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .expect(200);

    const staffAuth = await otpLogin('+77021120003', STAFF_DEVICE_ID);

    const scanRes = await request(server)
      .post('/api/v1/staff/qr/scan')
      .set('Authorization', `Bearer ${staffAuth.access_token}`)
      .set('X-Device-Id', STAFF_DEVICE_ID)
      .send({ token: qrToken });

    expect(scanRes.status).toBe(410);
    expect(scanRes.body.error).toBe('qr_token_revoked');
  });

  // ── G. Staff scans non-existent token → 404 ──────────────────────────────

  it('returns 404 qr_token_not_found for an unknown token (Scenario G)', async () => {
    // KG creation seeds the staff user (admin role) used as the scanner below.
    await createKgWithAdmin('qr-g', '+77021120004');
    const staffAuth = await otpLogin('+77021120004', STAFF_DEVICE_ID);

    const unknownToken = randomBytes(16).toString('hex');

    const scanRes = await request(server)
      .post('/api/v1/staff/qr/scan')
      .set('Authorization', `Bearer ${staffAuth.access_token}`)
      .set('X-Device-Id', STAFF_DEVICE_ID)
      .send({ token: unknownToken });

    expect(scanRes.status).toBe(404);
    expect(scanRes.body.error).toBe('qr_token_not_found');
  });

  // ── H. Rate-limit 60+1 → 429 ─────────────────────────────────────────────

  it('allows 60 scans then 429 qr_rate_limit_exceeded with Retry-After (Scenario H)', async () => {
    // KG creation seeds the staff user (admin role) used as the scanner below.
    await createKgWithAdmin('qr-h', '+77021120005');
    const staffAuth = await otpLogin('+77021120005', STAFF_DEVICE_ID);

    // The rate-limit check runs before token lookup, so any 32-hex string
    // triggers it. All 60 calls will return 404 (token not found) but that
    // is fine — they increment the counter.
    const anyToken = randomBytes(16).toString('hex');

    for (let i = 0; i < 60; i++) {
      const res = await request(server)
        .post('/api/v1/staff/qr/scan')
        .set('Authorization', `Bearer ${staffAuth.access_token}`)
        .set('X-Device-Id', STAFF_DEVICE_ID)
        .send({ token: anyToken });
      expect(res.status).not.toBe(429);
    }

    const exceeded = await request(server)
      .post('/api/v1/staff/qr/scan')
      .set('Authorization', `Bearer ${staffAuth.access_token}`)
      .set('X-Device-Id', STAFF_DEVICE_ID)
      .send({ token: anyToken });

    expect(exceeded.status).toBe(429);
    expect(exceeded.body.error).toBe('qr_rate_limit_exceeded');
    expect(typeof exceeded.body.details?.retryAfterSeconds).toBe('number');
    expect(exceeded.body.details.retryAfterSeconds).toBeGreaterThan(0);
    // Standard Retry-After HTTP header must be present (set by StaffQrController).
    expect(exceeded.headers['retry-after']).toBeDefined();
    expect(Number(exceeded.headers['retry-after'])).toBeGreaterThan(0);
  }, 30_000);

  // ── I. Admin revoke-all → revokedCount + 0 on repeat ─────────────────────

  it('revoke-all returns revokedCount; second call returns 0 (Scenario I)', async () => {
    const a = await createKgWithAdmin('qr-i', '+77021120006');
    const parentAuth = await otpLogin('+77021110007');

    await request(server)
      .get('/api/v1/users/me/qr')
      .set('Authorization', `Bearer ${parentAuth.access_token}`)
      .expect(200);

    const r1 = await request(server)
      .post(`/api/v1/admin/qr/revoke-all/${parentAuth.user.id}`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .expect(200);
    expect(r1.body.revokedCount).toBe(1);

    // Second call: no active tokens remain.
    const r2 = await request(server)
      .post(`/api/v1/admin/qr/revoke-all/${parentAuth.user.id}`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .expect(200);
    expect(r2.body.revokedCount).toBe(0);
  });

  // ── J. Cross-kg: kg-A staff scans kg-B parent token ──────────────────────

  it('kg-A staff scans kg-B parent token and gets kg-B child in linkedChildren (Scenario J)', async () => {
    // kg-A: the scanning staff belongs here. Creation seeds the staff user.
    await createKgWithAdmin('qr-j-a', '+77021120007');
    // kg-B: the parent and child belong here.
    const b = await createKgWithAdmin('qr-j-b', '+77021120008');
    const parentPhone = '+77021110008';

    const enrollment = await runEnrollmentCardCreated(b.adminToken, {
      contactName: 'Parent J',
      contactPhone: parentPhone,
      childName: 'Child J',
      childDob: '2021-06-01',
    });

    // Parent OTP login auto-approves primary guardian in kg-B.
    const parentAuth = await otpLogin(parentPhone);

    // Parent issues QR (cross-tenant endpoint, no kg scope guard required).
    const qrRes = await request(server)
      .get('/api/v1/users/me/qr')
      .set('Authorization', `Bearer ${parentAuth.access_token}`)
      .expect(200);

    // kg-A staff scans the kg-B parent's token.
    const staffAAuth = await otpLogin('+77021120007', STAFF_DEVICE_ID);

    const scanRes = await request(server)
      .post('/api/v1/staff/qr/scan')
      .set('Authorization', `Bearer ${staffAAuth.access_token}`)
      .set('X-Device-Id', STAFF_DEVICE_ID)
      .send({ token: qrRes.body.token })
      .expect(200);

    expect(scanRes.body.user.id).toBe(parentAuth.user.id);
    expect(scanRes.body.user.role).toBe('parent');

    // Cross-tenant: kg-B child appears in linkedChildren (bypass-RLS lookup).
    expect(Array.isArray(scanRes.body.linkedChildren)).toBe(true);
    expect(scanRes.body.linkedChildren).toHaveLength(1);
    expect(scanRes.body.linkedChildren[0].id).toBe(enrollment.childId);

    // Primary guardian with can_pickup = true (enrollment default).
    expect(scanRes.body.allowedActions).toEqual(
      expect.arrayContaining(['check_in', 'check_out']),
    );
  });
});
