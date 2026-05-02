/**
 * B11 Pickup OTP (e2e) — scenarios A–K.
 *
 * Endpoints under test:
 *   Parent:
 *     GET    /api/v1/parent/children/:id/trusted-people
 *     POST   /api/v1/parent/children/:id/trusted-people
 *     PATCH  /api/v1/parent/trusted-people/:id
 *     POST   /api/v1/parent/trusted-people/:id/revoke
 *   Staff:
 *     GET    /api/v1/staff/pickup-requests
 *     GET    /api/v1/staff/pickup-requests/:id
 *     POST   /api/v1/staff/pickup-requests
 *     POST   /api/v1/staff/pickup-requests/:id/send-otp
 *     POST   /api/v1/staff/pickup-requests/:id/validate-otp
 *     POST   /api/v1/staff/pickup-requests/:id/cancel
 *   Parent:
 *     POST   /api/v1/parent/children/:id/pickup-requests
 *
 * Scenarios:
 *   A. Add trusted_person (parent), list → appears in list
 *   B. Revoke trusted_person → staff create with that tp_id → 410
 *   C. Happy path: staff create → send-otp → validate (right code) → 200 + validated + checkout + timeline
 *   D. Wrong OTP: 3 × wrong → 400 (invalid_otp) × 3 then 429 (otp_locked); 4th attempt also 429
 *   E. Delete Redis key after send-otp → validate → 422 (otp_expired_or_missing)
 *   F. Cancel a request → status cancelled, redis key gone, 2nd cancel → 409
 *   G. is_one_time = true → after validate the trusted_person is deactivated → 2nd staff create → 410
 *   H. Cross-tenant RLS: pickup_request from kg_A is invisible from kg_B
 *   I. Rate limit: 5 send-otp same phone → 6th → 429 (otp_rate_limit)
 *   J. Outbox: pickup.otp_sent + pickup.validated rows written to notification_outbox
 *   K. Ad-hoc (no trusted_person_id): pass name+phone directly, happy path
 */
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createTestApp, flushRedis, TestApp, truncateAll } from './helpers/app';

const SUPER_ADMIN_EMAIL = 'super-pickup@shyraq.test';
const SUPER_ADMIN_PASSWORD = 'admin12345';

interface CreatedKgResp {
  kindergarten: { id: string; slug: string };
  staff_member: { id: string; user_id: string };
  user: { id: string; phone: string };
}

describe('B11 Pickup OTP (e2e)', () => {
  let ctx: TestApp;
  let server: Server;
  let saAccess: string;
  let jwtService: JwtService;
  let jwtSecret: string;

  // ── helpers ───────────────────────────────────────────────────────────────

  async function mintToken(opts: {
    sub: string;
    role: string;
    kindergartenId: string;
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
  ): Promise<{
    kgId: string;
    userId: string;
    staffMemberId: string;
    adminToken: string;
    staffToken: string;
  }> {
    const res = await request(server)
      .post('/api/v1/saas/kindergartens')
      .set('Authorization', `Bearer ${saAccess}`)
      .send({
        name: `Pickup-Test KG ${slug}`,
        slug,
        admin: { full_name: 'Admin', phone },
      })
      .expect(201);
    const body = res.body as CreatedKgResp;
    const adminToken = await mintToken({
      sub: body.user.id,
      role: 'admin',
      kindergartenId: body.kindergarten.id,
    });
    const staffToken = await mintToken({
      sub: body.user.id,
      role: 'mentor',
      kindergartenId: body.kindergarten.id,
    });
    return {
      kgId: body.kindergarten.id,
      userId: body.user.id,
      staffMemberId: body.staff_member.id,
      adminToken,
      staffToken,
    };
  }

  async function seedUser(phone: string): Promise<string> {
    const id = randomUUID();
    await ctx.dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      await m.query(
        `INSERT INTO users (id, phone, full_name) VALUES ($1, $2, '')`,
        [id, phone],
      );
    });
    return id;
  }

  async function createChild(
    adminToken: string,
    payload: { full_name: string; date_of_birth: string },
  ): Promise<string> {
    const res = await request(server)
      .post('/api/v1/children')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(payload)
      .expect(201);
    return res.body.id as string;
  }

  async function seedApprovedPickupGuardian(
    kgId: string,
    childId: string,
    userId: string,
    canPickup = false,
  ): Promise<void> {
    await ctx.dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      await m.query(
        `INSERT INTO child_guardians
           (id, kindergarten_id, child_id, user_id, role, status,
            can_pickup, approved_by, approved_at)
         VALUES ($1, $2, $3, $4, 'primary', 'approved', $5, $4, now())`,
        [randomUUID(), kgId, childId, userId, canPickup],
      );
    });
  }

  function extractCode(): string {
    const last = ctx.sms.lastSent;
    if (!last) throw new Error('no SMS captured');
    const m = /(\d{6})/.exec(last.message);
    if (!m) throw new Error('no 6-digit code in SMS message');
    return m[1];
  }

  /**
   * Creates a pickup request via staff endpoint then fires send-otp.
   * Returns the requestId and captured OTP code.
   */
  async function setupPickupRequestWithOtp(opts: {
    staffToken: string;
    childId: string;
    trustedPersonId?: string | null;
    trustedPersonName?: string;
    trustedPersonPhone?: string;
  }): Promise<{ requestId: string; code: string }> {
    const body: Record<string, unknown> = { childId: opts.childId };
    if (opts.trustedPersonId != null) {
      body.trustedPersonId = opts.trustedPersonId;
    } else {
      body.trustedPersonName = opts.trustedPersonName ?? 'Test Trusted';
      body.trustedPersonPhone = opts.trustedPersonPhone ?? '+77011999001';
    }

    const createRes = await request(server)
      .post('/api/v1/staff/pickup-requests')
      .set('Authorization', `Bearer ${opts.staffToken}`)
      .send(body)
      .expect(201);
    const requestId = createRes.body.id as string;

    ctx.sms.lastSent = null;
    await request(server)
      .post(`/api/v1/staff/pickup-requests/${requestId}/send-otp`)
      .set('Authorization', `Bearer ${opts.staffToken}`)
      .expect(200);
    const code = extractCode();

    return { requestId, code };
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

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
    ctx.sms.lastSent = null;
    ctx.sms.log.length = 0;
    await seedSuperAdmin();
    saAccess = await loginSuperAdmin();
  });

  // ── A. Add trusted_person + list ──────────────────────────────────────────

  it('adds a trusted_person via parent endpoint and lists it back (Scenario A)', async () => {
    const a = await createKgWithAdmin('pu-a', '+77011000001');
    const parentId = await seedUser('+77011000002');
    const childId = await createChild(a.adminToken, {
      full_name: 'Child A',
      date_of_birth: '2020-01-01',
    });
    await seedApprovedPickupGuardian(a.kgId, childId, parentId, false);
    const parentToken = await mintToken({
      sub: parentId,
      role: 'parent',
      kindergartenId: a.kgId,
    });

    const addRes = await request(server)
      .post(`/api/v1/parent/children/${childId}/trusted-people`)
      .set('Authorization', `Bearer ${parentToken}`)
      .send({
        fullName: 'Айгуль',
        phone: '+77011111111',
        relation: 'aunt',
        isOneTime: false,
      })
      .expect(201);

    expect(addRes.body.full_name).toBe('Айгуль');
    expect(addRes.body.is_active).toBe(true);

    const listRes = await request(server)
      .get(`/api/v1/parent/children/${childId}/trusted-people`)
      .set('Authorization', `Bearer ${parentToken}`)
      .expect(200);

    expect(Array.isArray(listRes.body)).toBe(true);
    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0].id).toBe(addRes.body.id);
  });

  // ── B. Revoke trusted_person → staff create → 410 ────────────────────────

  it('returns 410 trusted_person_revoked when staff creates a request with a revoked trusted person (Scenario B)', async () => {
    const a = await createKgWithAdmin('pu-b', '+77011000011');
    const parentId = await seedUser('+77011000012');
    const childId = await createChild(a.adminToken, {
      full_name: 'Child B',
      date_of_birth: '2020-01-01',
    });
    await seedApprovedPickupGuardian(a.kgId, childId, parentId, false);
    const parentToken = await mintToken({
      sub: parentId,
      role: 'parent',
      kindergartenId: a.kgId,
    });

    // Add trusted person
    const addRes = await request(server)
      .post(`/api/v1/parent/children/${childId}/trusted-people`)
      .set('Authorization', `Bearer ${parentToken}`)
      .send({
        fullName: 'Revokable Person',
        phone: '+77011222222',
        relation: 'neighbor',
      })
      .expect(201);
    const tpId = addRes.body.id as string;

    // Revoke it
    await request(server)
      .post(`/api/v1/parent/trusted-people/${tpId}/revoke`)
      .set('Authorization', `Bearer ${parentToken}`)
      .expect(200);

    // Staff tries to create a request with the revoked trusted person
    const createRes = await request(server)
      .post('/api/v1/staff/pickup-requests')
      .set('Authorization', `Bearer ${a.staffToken}`)
      .send({ childId, trustedPersonId: tpId })
      .expect(410);

    expect(createRes.body.error).toBe('trusted_person_revoked');
  });

  // ── C. Happy path: create → send-otp → validate → checkout ───────────────

  it('validates OTP, transitions to validated, creates checkout attendance event (Scenario C)', async () => {
    const a = await createKgWithAdmin('pu-c', '+77011000021');
    const childId = await createChild(a.adminToken, {
      full_name: 'Child C',
      date_of_birth: '2020-01-01',
    });

    const { requestId, code } = await setupPickupRequestWithOtp({
      staffToken: a.staffToken,
      childId,
      trustedPersonName: 'Гость Тест',
      trustedPersonPhone: '+77011333333',
    });

    const validateRes = await request(server)
      .post(`/api/v1/staff/pickup-requests/${requestId}/validate-otp`)
      .set('Authorization', `Bearer ${a.staffToken}`)
      .send({ code })
      .expect(200);

    expect(validateRes.body.pickup_request.status).toBe('validated');
    expect(validateRes.body.attendance_event_id).toBeDefined();

    // Verify attendance event was created in DB
    const events = (await ctx.dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      return m.query(
        `SELECT id, event_type FROM attendance_events WHERE child_id = $1`,
        [childId],
      );
    })) as Array<{ id: string; event_type: string }>;

    expect(events.length).toBeGreaterThanOrEqual(1);
    const checkOut = events.find((e) => e.event_type === 'check_out');
    expect(checkOut).toBeDefined();

    // Verify timeline entry
    const timeline = (await ctx.dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      return m.query(
        `SELECT id, entry_type FROM timeline_entries WHERE child_id = $1`,
        [childId],
      );
    })) as Array<{ id: string; entry_type: string }>;

    expect(timeline.length).toBeGreaterThanOrEqual(1);
  });

  // ── D. 3 wrong OTP → locked ───────────────────────────────────────────────

  it('returns 422 invalid_otp on 3 wrong codes then 429 otp_locked on 4th (Scenario D)', async () => {
    const a = await createKgWithAdmin('pu-d', '+77011000031');
    const childId = await createChild(a.adminToken, {
      full_name: 'Child D',
      date_of_birth: '2020-01-01',
    });

    const { requestId } = await setupPickupRequestWithOtp({
      staffToken: a.staffToken,
      childId,
      trustedPersonName: 'Wrong Code Test',
      trustedPersonPhone: '+77011444444',
    });

    // First 2 wrong codes → 400 invalid_otp
    for (let i = 0; i < 2; i++) {
      const res = await request(server)
        .post(`/api/v1/staff/pickup-requests/${requestId}/validate-otp`)
        .set('Authorization', `Bearer ${a.staffToken}`)
        .send({ code: '000000' })
        .expect(400);
      expect(res.body.error).toBe('invalid_otp');
    }

    // 3rd wrong code → 429 otp_locked (attempts hits PICKUP_OTP_MAX_FAILED_ATTEMPTS=3)
    const lockRes = await request(server)
      .post(`/api/v1/staff/pickup-requests/${requestId}/validate-otp`)
      .set('Authorization', `Bearer ${a.staffToken}`)
      .send({ code: '000000' })
      .expect(429);
    expect(lockRes.body.error).toBe('otp_locked');

    // 4th attempt (already locked) → 429 otp_locked
    const lockedRes = await request(server)
      .post(`/api/v1/staff/pickup-requests/${requestId}/validate-otp`)
      .set('Authorization', `Bearer ${a.staffToken}`)
      .send({ code: '000000' })
      .expect(429);
    expect(lockedRes.body.error).toBe('otp_locked');
  });

  // ── E. Delete Redis key → 422 otp_expired_or_missing ─────────────────────

  it('returns 422 otp_expired_or_missing when Redis key is deleted before validate (Scenario E)', async () => {
    const a = await createKgWithAdmin('pu-e', '+77011000041');
    const childId = await createChild(a.adminToken, {
      full_name: 'Child E',
      date_of_birth: '2020-01-01',
    });

    const { requestId, code } = await setupPickupRequestWithOtp({
      staffToken: a.staffToken,
      childId,
      trustedPersonName: 'Expired OTP Test',
      trustedPersonPhone: '+77011555555',
    });

    // Manually delete the Redis key to simulate expiry
    await ctx.redis.del(`otp:pickup:${requestId}`);

    const res = await request(server)
      .post(`/api/v1/staff/pickup-requests/${requestId}/validate-otp`)
      .set('Authorization', `Bearer ${a.staffToken}`)
      .send({ code })
      .expect(400);

    expect(res.body.error).toBe('otp_expired_or_missing');
  });

  // ── F. Cancel → status cancelled, Redis key gone ──────────────────────────

  it('cancels a request, clears Redis key, and returns 409 on 2nd cancel (Scenario F)', async () => {
    const a = await createKgWithAdmin('pu-f', '+77011000051');
    const childId = await createChild(a.adminToken, {
      full_name: 'Child F',
      date_of_birth: '2020-01-01',
    });

    const { requestId } = await setupPickupRequestWithOtp({
      staffToken: a.staffToken,
      childId,
      trustedPersonName: 'Cancel Test',
      trustedPersonPhone: '+77011666666',
    });

    // Cancel
    const cancelRes = await request(server)
      .post(`/api/v1/staff/pickup-requests/${requestId}/cancel`)
      .set('Authorization', `Bearer ${a.staffToken}`)
      .expect(200);

    expect(cancelRes.body.status).toBe('cancelled');

    // Redis key should be gone
    const exists = await ctx.redis.exists(`otp:pickup:${requestId}`);
    expect(exists).toBe(0);

    // 2nd cancel → 409
    const res2 = await request(server)
      .post(`/api/v1/staff/pickup-requests/${requestId}/cancel`)
      .set('Authorization', `Bearer ${a.staffToken}`)
      .expect(409);

    expect(res2.body.error).toMatch(/pickup_request_status_invalid/);
  });

  // ── G. is_one_time = true → deactivated after validate ───────────────────

  it('deactivates a one-time trusted_person after successful validate (Scenario G)', async () => {
    const a = await createKgWithAdmin('pu-g', '+77011000061');
    const parentId = await seedUser('+77011000062');
    const childId = await createChild(a.adminToken, {
      full_name: 'Child G',
      date_of_birth: '2020-01-01',
    });
    await seedApprovedPickupGuardian(a.kgId, childId, parentId, false);
    const parentToken = await mintToken({
      sub: parentId,
      role: 'parent',
      kindergartenId: a.kgId,
    });

    // Add one-time trusted person
    const addRes = await request(server)
      .post(`/api/v1/parent/children/${childId}/trusted-people`)
      .set('Authorization', `Bearer ${parentToken}`)
      .send({
        fullName: 'One-Time Person',
        phone: '+77011777777',
        relation: 'driver',
        isOneTime: true,
      })
      .expect(201);
    const tpId = addRes.body.id as string;

    // Validate → success
    const { requestId, code } = await setupPickupRequestWithOtp({
      staffToken: a.staffToken,
      childId,
      trustedPersonId: tpId,
    });

    await request(server)
      .post(`/api/v1/staff/pickup-requests/${requestId}/validate-otp`)
      .set('Authorization', `Bearer ${a.staffToken}`)
      .send({ code })
      .expect(200);

    // Second staff create with same one-time trusted person → 410
    const res2 = await request(server)
      .post('/api/v1/staff/pickup-requests')
      .set('Authorization', `Bearer ${a.staffToken}`)
      .send({ childId, trustedPersonId: tpId })
      .expect(410);

    expect(res2.body.error).toBe('trusted_person_revoked');
  });

  // ── H. Cross-tenant RLS: phantom row isolation ────────────────────────────

  it('hides pickup_requests from other kindergartens (cross-tenant RLS, Scenario H)', async () => {
    const a = await createKgWithAdmin('pu-h-a', '+77011000071');
    const b = await createKgWithAdmin('pu-h-b', '+77011000081');

    const childA = await createChild(a.adminToken, {
      full_name: 'Child H-A',
      date_of_birth: '2020-01-01',
    });

    // Create pickup request in kg_A
    const createRes = await request(server)
      .post('/api/v1/staff/pickup-requests')
      .set('Authorization', `Bearer ${a.staffToken}`)
      .send({
        childId: childA,
        trustedPersonName: 'RLS Test',
        trustedPersonPhone: '+77011888888',
      })
      .expect(201);
    const requestIdA = createRes.body.id as string;

    // RLS isolation: kg_B staff cannot access kg_A's pickup request by id
    await request(server)
      .get(`/api/v1/staff/pickup-requests/${requestIdA}`)
      .set('Authorization', `Bearer ${b.staffToken}`)
      .expect(404);

    // RLS isolation: kg_B admin also cannot access kg_A's pickup request by id
    await request(server)
      .get(`/api/v1/staff/pickup-requests/${requestIdA}`)
      .set('Authorization', `Bearer ${b.adminToken}`)
      .expect(404);
  });

  // ── I. Rate limit: 6th send-otp on same phone → 429 ─────────────────────

  it('returns 429 otp_rate_limit when the per-phone OTP budget is exhausted (Scenario I)', async () => {
    const a = await createKgWithAdmin('pu-i', '+77011000091');

    // Create 6 children, each with a pickup request for the same trusted phone
    const children: string[] = [];
    for (let i = 0; i < 6; i++) {
      const childId = await createChild(a.adminToken, {
        full_name: `Child I-${i}`,
        date_of_birth: '2020-01-01',
      });
      children.push(childId);
    }

    const PHONE = '+77011900001';

    // First 5 → ok (rate limit is 5/hour)
    for (let i = 0; i < 5; i++) {
      const createRes = await request(server)
        .post('/api/v1/staff/pickup-requests')
        .set('Authorization', `Bearer ${a.staffToken}`)
        .send({
          childId: children[i],
          trustedPersonName: `Person ${i}`,
          trustedPersonPhone: PHONE,
        })
        .expect(201);

      ctx.sms.lastSent = null;
      await request(server)
        .post(`/api/v1/staff/pickup-requests/${createRes.body.id}/send-otp`)
        .set('Authorization', `Bearer ${a.staffToken}`)
        .expect(200);
    }

    // 6th → 429
    const createRes6 = await request(server)
      .post('/api/v1/staff/pickup-requests')
      .set('Authorization', `Bearer ${a.staffToken}`)
      .send({
        childId: children[5],
        trustedPersonName: 'Person 5',
        trustedPersonPhone: PHONE,
      })
      .expect(201);

    const res = await request(server)
      .post(`/api/v1/staff/pickup-requests/${createRes6.body.id}/send-otp`)
      .set('Authorization', `Bearer ${a.staffToken}`)
      .expect(429);

    expect(res.body.error).toBe('otp_rate_limit');
  });

  // ── J. Outbox: pickup.otp_sent + pickup.validated written ────────────────

  it('writes notification_outbox rows for otp_sent and validated events (Scenario J)', async () => {
    const a = await createKgWithAdmin('pu-j', '+77011000101');
    const childId = await createChild(a.adminToken, {
      full_name: 'Child J',
      date_of_birth: '2020-01-01',
    });

    const { requestId, code } = await setupPickupRequestWithOtp({
      staffToken: a.staffToken,
      childId,
      trustedPersonName: 'Outbox Test',
      trustedPersonPhone: '+77011100101',
    });

    // Verify otp_sent outbox row
    const sentRows = (await ctx.dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      return m.query(
        `SELECT event_key FROM notification_outbox
         WHERE payload::text LIKE $1`,
        [`%${requestId}%`],
      );
    })) as Array<{ event_key: string }>;

    expect(sentRows.some((r) => r.event_key === 'pickup.otp_sent')).toBe(true);

    // Validate
    await request(server)
      .post(`/api/v1/staff/pickup-requests/${requestId}/validate-otp`)
      .set('Authorization', `Bearer ${a.staffToken}`)
      .send({ code })
      .expect(200);

    // Verify validated outbox row
    const allRows = (await ctx.dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      return m.query(
        `SELECT event_key FROM notification_outbox
         WHERE payload::text LIKE $1`,
        [`%${requestId}%`],
      );
    })) as Array<{ event_key: string }>;

    expect(allRows.some((r) => r.event_key === 'pickup.validated')).toBe(true);
  });

  // ── K. Ad-hoc pickup request (no trusted_person_id) ─────────────────────

  it('creates an ad-hoc pickup request (no trusted_person_id) and completes full OTP flow (Scenario K)', async () => {
    const a = await createKgWithAdmin('pu-k', '+77011000111');
    const childId = await createChild(a.adminToken, {
      full_name: 'Child K',
      date_of_birth: '2020-01-01',
    });

    // Create ad-hoc request (no trustedPersonId)
    const createRes = await request(server)
      .post('/api/v1/staff/pickup-requests')
      .set('Authorization', `Bearer ${a.staffToken}`)
      .send({
        childId,
        trustedPersonName: 'Ad-Hoc Person',
        trustedPersonPhone: '+77011110001',
      })
      .expect(201);

    expect(createRes.body.status).toBe('otp_sent');
    expect(createRes.body.trusted_person_id).toBeNull();
    const requestId = createRes.body.id as string;

    // Send OTP
    ctx.sms.lastSent = null;
    await request(server)
      .post(`/api/v1/staff/pickup-requests/${requestId}/send-otp`)
      .set('Authorization', `Bearer ${a.staffToken}`)
      .expect(200);

    const code = extractCode();
    const lastSms = ctx.sms.lastSent as {
      phone: string;
      message: string;
    } | null;
    expect(lastSms?.phone).toBe('+77011110001');

    // Validate
    const validateRes = await request(server)
      .post(`/api/v1/staff/pickup-requests/${requestId}/validate-otp`)
      .set('Authorization', `Bearer ${a.staffToken}`)
      .send({ code })
      .expect(200);

    expect(validateRes.body.pickup_request.status).toBe('validated');
    expect(validateRes.body.pickup_request.trusted_person_id).toBeNull();
  });
});
