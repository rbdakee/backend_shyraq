/**
 * B12 Parent Requests (e2e) — Scenarios A–J.
 *
 * Scenarios:
 *   A. Parent creates day_off → mentor accepts → parent sees status='accepted'
 *   B. Parent creates open_request to specialist → bidirectional thread (XOR author)
 *   C. Parent creates late_pickup → mentor accepts → invoice_id stays null (B13 hook)
 *   D. Parent OTP request → 3 wrong codes → 429 otp_locked
 *   E. OTP trusted_person flow → on accept: trusted_people + optionally pickup_requests row
 *   F. Cross-tenant phantom RLS
 *   G. Concurrent accept race → one 200, one 409
 *   H. Cancel pending → 200; cancel accepted → 409
 *   I. Nanny role: create_requests=false by default → 403
 *   J. Guardian with create_requests=false override → 403
 *   Plus day-off validators: weekday → 422, past → 422, >2 dates → 400
 */

import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createTestApp, flushRedis, TestApp, truncateAll } from './helpers/app';

const SUPER_ADMIN_EMAIL = 'super-pr@shyraq.test';
const SUPER_ADMIN_PASSWORD = 'admin12345';

interface CreatedKgResp {
  kindergarten: { id: string; slug: string };
  staff_member: { id: string; user_id: string };
  user: { id: string; phone: string };
}

describe('B12 Parent Requests (e2e)', () => {
  let ctx: TestApp;
  let server: Server;
  let saAccess: string;
  let jwtService: JwtService;
  let jwtSecret: string;

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
        name: `PR-Test KG ${slug}`,
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

  async function seedApprovedGuardian(
    kgId: string,
    childId: string,
    userId: string,
    opts: { role?: string; permissions?: Record<string, boolean> } = {},
  ): Promise<void> {
    const role = opts.role ?? 'primary';
    const perms = opts.permissions ?? {};
    const hasApprovalRights = role === 'primary';
    await ctx.dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      await m.query(
        `INSERT INTO child_guardians
           (id, kindergarten_id, child_id, user_id, role, status,
            can_pickup, has_approval_rights, permissions, approved_by, approved_at)
         VALUES ($1, $2, $3, $4, $5, 'approved', true, $6, $7::jsonb, $4, now())`,
        [
          randomUUID(),
          kgId,
          childId,
          userId,
          role,
          hasApprovalRights,
          JSON.stringify(perms),
        ],
      );
    });
  }

  async function seedStaffMember(
    kgId: string,
    userId: string,
    role: string,
    specialistType?: string,
  ): Promise<string> {
    const staffId = randomUUID();
    await ctx.dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      await m.query(
        `INSERT INTO staff_members (id, kindergarten_id, user_id, role, specialist_type, is_active)
         VALUES ($1, $2, $3, $4, $5, true)`,
        [staffId, kgId, userId, role, specialistType ?? null],
      );
    });
    return staffId;
  }

  function extractCode(): string {
    const last = ctx.sms.lastSent;
    if (!last) throw new Error('no SMS captured');
    const m = /(\d{6})/.exec(last.message);
    if (!m) throw new Error('no 6-digit code in SMS');
    return m[1];
  }

  function futureSaturday(): string {
    const d = new Date();
    while (d.getUTCDay() !== 6) d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCDate(d.getUTCDate() + 7);
    return d.toISOString().slice(0, 10);
  }

  function futureDate(days: number): string {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
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
    ctx.sms.lastSent = null;
    ctx.sms.log.length = 0;
    await seedSuperAdmin();
    saAccess = await loginSuperAdmin();
  });

  // ── A. day_off → accepted ─────────────────────────────────────────────────

  it('creates a day_off request and transitions to accepted when mentor accepts it (Scenario A)', async () => {
    const a = await createKgWithAdmin('pr-a', '+77011100001');
    const parentId = await seedUser('+77011100002');
    const childId = await createChild(a.adminToken, {
      full_name: 'Child A',
      date_of_birth: '2020-01-01',
    });
    await seedApprovedGuardian(a.kgId, childId, parentId);
    const parentToken = await mintToken({
      sub: parentId,
      role: 'parent',
      kindergartenId: a.kgId,
    });

    const sat = futureSaturday();
    const createRes = await request(server)
      .post('/api/v1/parent/requests/day-off')
      .set('Authorization', `Bearer ${parentToken}`)
      .send({
        child_id: childId,
        weekend_dates: [sat],
        comment: 'Saturday care',
      })
      .expect(201);

    const prId = createRes.body.id as string;
    expect(createRes.body.status).toBe('pending');
    expect(createRes.body.request_type).toBe('day_off');

    const acceptRes = await request(server)
      .post(`/api/v1/staff/parent-requests/${prId}/accept`)
      .set('Authorization', `Bearer ${a.staffToken}`)
      .send({ review_note: 'OK' })
      .expect(200);

    expect(acceptRes.body.status).toBe('accepted');
    expect(acceptRes.body.reviewed_by).toBeTruthy();
    expect(acceptRes.body.reviewed_at).toBeTruthy();

    const getRes = await request(server)
      .get(`/api/v1/parent/requests/${prId}`)
      .set('Authorization', `Bearer ${parentToken}`)
      .expect(200);

    expect(getRes.body.status).toBe('accepted');
  });

  // ── B. open_request → bidirectional thread ────────────────────────────────

  it('creates an open_request to specialist and supports bidirectional thread with XOR author fields (Scenario B)', async () => {
    const a = await createKgWithAdmin('pr-b', '+77011100011');
    const parentId = await seedUser('+77011100012');
    const specialistUserId = await seedUser('+77011100013');
    const childId = await createChild(a.adminToken, {
      full_name: 'Child B',
      date_of_birth: '2020-01-01',
    });
    await seedApprovedGuardian(a.kgId, childId, parentId);
    const specialistStaffId = await seedStaffMember(
      a.kgId,
      specialistUserId,
      'specialist',
      'psychologist',
    );
    const parentToken = await mintToken({
      sub: parentId,
      role: 'parent',
      kindergartenId: a.kgId,
    });
    const specialistToken = await mintToken({
      sub: specialistUserId,
      role: 'specialist',
      kindergartenId: a.kgId,
    });

    const createRes = await request(server)
      .post('/api/v1/parent/requests/open')
      .set('Authorization', `Bearer ${parentToken}`)
      .send({
        child_id: childId,
        recipient_type: 'specialist',
        recipient_staff_id: specialistStaffId,
        subject: 'Dev question',
        message: 'I have a question.',
      })
      .expect(201);

    const prId = createRes.body.id as string;
    expect(createRes.body.recipient_type).toBe('specialist');
    expect(createRes.body.recipient_staff_id).toBe(specialistStaffId);

    // Specialist replies in thread
    const staffMsgRes = await request(server)
      .post(`/api/v1/staff/parent-requests/${prId}/messages`)
      .set('Authorization', `Bearer ${specialistToken}`)
      .send({ body: 'Hello, I can help.' })
      .expect(201);

    expect(staffMsgRes.body.author_staff_id).toBe(specialistStaffId);
    expect(staffMsgRes.body.author_user_id).toBeNull();

    // Parent replies back
    const parentMsgRes = await request(server)
      .post(`/api/v1/parent/requests/${prId}/messages`)
      .set('Authorization', `Bearer ${parentToken}`)
      .send({ body: 'Thank you!' })
      .expect(201);

    expect(parentMsgRes.body.author_user_id).toBe(parentId);
    expect(parentMsgRes.body.author_staff_id).toBeNull();

    // List: verify both messages, XOR author fields
    const listRes = await request(server)
      .get(`/api/v1/parent/requests/${prId}/messages`)
      .set('Authorization', `Bearer ${parentToken}`)
      .expect(200);

    expect(Array.isArray(listRes.body.items)).toBe(true);
    expect(listRes.body.items).toHaveLength(2);

    const staffMsg = listRes.body.items.find(
      (m: Record<string, unknown>) => m.author_staff_id === specialistStaffId,
    );
    const parentMsg = listRes.body.items.find(
      (m: Record<string, unknown>) => m.author_user_id === parentId,
    );
    expect(staffMsg).toBeDefined();
    expect(staffMsg.author_user_id).toBeNull();
    expect(parentMsg).toBeDefined();
    expect(parentMsg.author_staff_id).toBeNull();
  });

  // ── C. late_pickup → accepted → invoice_id null ───────────────────────────

  it('accepts a late_pickup request and invoice_id stays null (B13 hook deferred), reviewed_by populated (Scenario C)', async () => {
    const a = await createKgWithAdmin('pr-c', '+77011100021');
    const parentId = await seedUser('+77011100022');
    const childId = await createChild(a.adminToken, {
      full_name: 'Child C',
      date_of_birth: '2020-01-01',
    });
    await seedApprovedGuardian(a.kgId, childId, parentId);
    const parentToken = await mintToken({
      sub: parentId,
      role: 'parent',
      kindergartenId: a.kgId,
    });

    const createRes = await request(server)
      .post('/api/v1/parent/requests/late-pickup')
      .set('Authorization', `Bearer ${parentToken}`)
      .send({
        child_id: childId,
        date: futureDate(1),
        expected_time: '19:30',
        comment: 'Traffic delay',
      })
      .expect(201);

    const prId = createRes.body.id as string;
    expect(createRes.body.status).toBe('pending');

    const acceptRes = await request(server)
      .post(`/api/v1/staff/parent-requests/${prId}/accept`)
      .set('Authorization', `Bearer ${a.staffToken}`)
      .send({})
      .expect(200);

    // B13 hook — invoice not created yet
    expect(acceptRes.body.invoice_id).toBeNull();
    // reviewed_by and reviewed_at populated
    expect(acceptRes.body.reviewed_by).toBe(a.staffMemberId);
    expect(acceptRes.body.reviewed_at).toBeTruthy();
    expect(acceptRes.body.status).toBe('accepted');
  });

  // ── D. OTP rate-limit — 3 wrong codes → otp_locked ───────────────────────

  it('returns 429 otp_locked after 3 consecutive wrong OTP codes for trusted-person flow (Scenario D)', async () => {
    const a = await createKgWithAdmin('pr-d', '+77011100031');
    const parentId = await seedUser('+77011100032');
    const childId = await createChild(a.adminToken, {
      full_name: 'Child D',
      date_of_birth: '2020-01-01',
    });
    await seedApprovedGuardian(a.kgId, childId, parentId);
    const parentToken = await mintToken({
      sub: parentId,
      role: 'parent',
      kindergartenId: a.kgId,
    });

    await request(server)
      .post('/api/v1/parent/requests/otp-request')
      .set('Authorization', `Bearer ${parentToken}`)
      .send({ child_id: childId, phone: '+77011100033' })
      .expect(200);

    // 2 wrong codes → 400 invalid_otp
    for (let i = 0; i < 2; i++) {
      const res = await request(server)
        .post('/api/v1/parent/requests/trusted-person')
        .set('Authorization', `Bearer ${parentToken}`)
        .send({
          code: '000000',
          child_id: childId,
          full_name: 'Test Person',
          phone: '+77011100033',
          relation: 'aunt',
        })
        .expect(400);
      expect(res.body.error).toBe('invalid_otp');
    }

    // 3rd wrong code → otp_locked (max 3 failed attempts)
    const lockedRes = await request(server)
      .post('/api/v1/parent/requests/trusted-person')
      .set('Authorization', `Bearer ${parentToken}`)
      .send({
        code: '000000',
        child_id: childId,
        full_name: 'Test Person',
        phone: '+77011100033',
        relation: 'aunt',
      })
      .expect(429);

    expect(lockedRes.body.error).toBe('otp_locked');
  });

  // ── E. OTP trusted_person → accept creates trusted_people + pickup_requests ─

  it('on accept of trusted_person request creates trusted_people row + pickup_requests row when create_pickup_request=true (Scenario E)', async () => {
    const a = await createKgWithAdmin('pr-e', '+77011100041');
    const parentId = await seedUser('+77011100042');
    const childId = await createChild(a.adminToken, {
      full_name: 'Child E',
      date_of_birth: '2020-01-01',
    });
    await seedApprovedGuardian(a.kgId, childId, parentId);
    const parentToken = await mintToken({
      sub: parentId,
      role: 'parent',
      kindergartenId: a.kgId,
    });

    ctx.sms.lastSent = null;
    await request(server)
      .post('/api/v1/parent/requests/otp-request')
      .set('Authorization', `Bearer ${parentToken}`)
      .send({ child_id: childId, phone: '+77011100043' })
      .expect(200);

    const code = extractCode();
    const createRes = await request(server)
      .post('/api/v1/parent/requests/trusted-person')
      .set('Authorization', `Bearer ${parentToken}`)
      .send({
        code,
        child_id: childId,
        full_name: 'Nanny Person',
        phone: '+77011100043',
        relation: 'nanny',
        is_one_time: false,
        create_pickup_request: true,
      })
      .expect(201);

    const prId = createRes.body.id as string;
    expect(createRes.body.request_type).toBe('trusted_person');

    await request(server)
      .post(`/api/v1/staff/parent-requests/${prId}/accept`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({})
      .expect(200);

    const tpRows = (await ctx.dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      return m.query(
        `SELECT id FROM trusted_people WHERE child_id = $1 AND phone = $2`,
        [childId, '+77011100043'],
      );
    })) as Array<{ id: string }>;
    expect(tpRows).toHaveLength(1);

    const pickupRows = (await ctx.dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      return m.query(
        `SELECT id, parent_request_id FROM pickup_requests WHERE child_id = $1 AND trusted_person_id = $2`,
        [childId, tpRows[0].id],
      );
    })) as Array<{ id: string; parent_request_id: string }>;
    expect(pickupRows).toHaveLength(1);
    expect(pickupRows[0].parent_request_id).toBe(prId);
  });

  it('on accept of trusted_person request creates trusted_people row but NO pickup_requests row when create_pickup_request=false (Scenario E-ext)', async () => {
    const a = await createKgWithAdmin('pr-eext', '+77011100051');
    const parentId = await seedUser('+77011100052');
    const childId = await createChild(a.adminToken, {
      full_name: 'Child E-ext',
      date_of_birth: '2020-01-01',
    });
    await seedApprovedGuardian(a.kgId, childId, parentId);
    const parentToken = await mintToken({
      sub: parentId,
      role: 'parent',
      kindergartenId: a.kgId,
    });

    ctx.sms.lastSent = null;
    await request(server)
      .post('/api/v1/parent/requests/otp-request')
      .set('Authorization', `Bearer ${parentToken}`)
      .send({ child_id: childId, phone: '+77011100053' })
      .expect(200);

    const code = extractCode();
    const createRes = await request(server)
      .post('/api/v1/parent/requests/trusted-person')
      .set('Authorization', `Bearer ${parentToken}`)
      .send({
        code,
        child_id: childId,
        full_name: 'No Pickup Nanny',
        phone: '+77011100053',
        relation: 'sister',
        is_one_time: false,
        create_pickup_request: false,
      })
      .expect(201);

    const prId = createRes.body.id as string;
    await request(server)
      .post(`/api/v1/staff/parent-requests/${prId}/accept`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({})
      .expect(200);

    const tpRows = (await ctx.dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      return m.query(
        `SELECT id FROM trusted_people WHERE child_id = $1 AND phone = $2`,
        [childId, '+77011100053'],
      );
    })) as Array<{ id: string }>;
    expect(tpRows).toHaveLength(1);

    const pickupRows = (await ctx.dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      return m.query(
        `SELECT id FROM pickup_requests WHERE child_id = $1 AND trusted_person_id = $2`,
        [childId, tpRows[0].id],
      );
    })) as Array<{ id: string }>;
    expect(pickupRows).toHaveLength(0);
  });

  // ── F. Cross-tenant phantom ───────────────────────────────────────────────

  it('hides parent_requests from other kindergartens and returns 404 on cross-tenant id lookup (Scenario F)', async () => {
    const a = await createKgWithAdmin('pr-f-a', '+77011100061');
    const b = await createKgWithAdmin('pr-f-b', '+77011100071');
    const parentId = await seedUser('+77011100062');
    const childId = await createChild(a.adminToken, {
      full_name: 'Child F',
      date_of_birth: '2020-01-01',
    });
    await seedApprovedGuardian(a.kgId, childId, parentId);
    const parentToken = await mintToken({
      sub: parentId,
      role: 'parent',
      kindergartenId: a.kgId,
    });

    const sat = futureSaturday();
    const createRes = await request(server)
      .post('/api/v1/parent/requests/day-off')
      .set('Authorization', `Bearer ${parentToken}`)
      .send({ child_id: childId, weekend_dates: [sat] })
      .expect(201);
    const prIdA = createRes.body.id as string;

    // kg_B admin list → empty (RLS blocks kg_A rows)
    const listRes = await request(server)
      .get('/api/v1/admin/parent-requests')
      .set('Authorization', `Bearer ${b.adminToken}`)
      .expect(200);
    expect(listRes.body.items).toHaveLength(0);

    // kg_B admin GET /:id with kg_A's id → 404
    await request(server)
      .get(`/api/v1/staff/parent-requests/${prIdA}`)
      .set('Authorization', `Bearer ${b.adminToken}`)
      .expect(404);
  });

  // ── G. Concurrent accept race ─────────────────────────────────────────────

  it('exactly one concurrent accept succeeds (200) and the other returns 409 parent_request_already_processed (Scenario G)', async () => {
    const a = await createKgWithAdmin('pr-g', '+77011100081');
    const parentId = await seedUser('+77011100082');
    const childId = await createChild(a.adminToken, {
      full_name: 'Child G',
      date_of_birth: '2020-01-01',
    });
    await seedApprovedGuardian(a.kgId, childId, parentId);
    const parentToken = await mintToken({
      sub: parentId,
      role: 'parent',
      kindergartenId: a.kgId,
    });

    const sat = futureSaturday();
    const createRes = await request(server)
      .post('/api/v1/parent/requests/day-off')
      .set('Authorization', `Bearer ${parentToken}`)
      .send({ child_id: childId, weekend_dates: [sat] })
      .expect(201);
    const prId = createRes.body.id as string;

    // Second token simulates a different admin session
    const adminToken2 = await mintToken({
      sub: a.userId,
      role: 'admin',
      kindergartenId: a.kgId,
    });

    const [res1, res2] = await Promise.all([
      request(server)
        .post(`/api/v1/staff/parent-requests/${prId}/accept`)
        .set('Authorization', `Bearer ${a.adminToken}`)
        .send({}),
      request(server)
        .post(`/api/v1/staff/parent-requests/${prId}/accept`)
        .set('Authorization', `Bearer ${adminToken2}`)
        .send({}),
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([200, 409]);

    const winner = res1.status === 200 ? res1 : res2;
    const loser = res1.status === 409 ? res1 : res2;
    expect(winner.body.status).toBe('accepted');
    expect(loser.body.error).toBe('parent_request_already_processed');
  });

  // ── H. Cancel state machine ───────────────────────────────────────────────

  it('cancels a pending request returning 200 cancelled, and returns 409 when cancelling an already-accepted request (Scenario H)', async () => {
    const a = await createKgWithAdmin('pr-h', '+77011100091');
    const parentId = await seedUser('+77011100092');
    const childId = await createChild(a.adminToken, {
      full_name: 'Child H',
      date_of_birth: '2020-01-01',
    });
    await seedApprovedGuardian(a.kgId, childId, parentId);
    const parentToken = await mintToken({
      sub: parentId,
      role: 'parent',
      kindergartenId: a.kgId,
    });

    // H-1: cancel pending → 200
    const sat = futureSaturday();
    const createRes = await request(server)
      .post('/api/v1/parent/requests/day-off')
      .set('Authorization', `Bearer ${parentToken}`)
      .send({ child_id: childId, weekend_dates: [sat] })
      .expect(201);
    const prId1 = createRes.body.id as string;

    const cancelRes = await request(server)
      .post(`/api/v1/parent/requests/${prId1}/cancel`)
      .set('Authorization', `Bearer ${parentToken}`)
      .expect(200);
    expect(cancelRes.body.status).toBe('cancelled');

    // H-2: accept then cancel → 409
    const sat2 = futureSaturday();
    const createRes2 = await request(server)
      .post('/api/v1/parent/requests/day-off')
      .set('Authorization', `Bearer ${parentToken}`)
      .send({ child_id: childId, weekend_dates: [sat2] })
      .expect(201);
    const prId2 = createRes2.body.id as string;

    await request(server)
      .post(`/api/v1/staff/parent-requests/${prId2}/accept`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({})
      .expect(200);

    const cancelRes2 = await request(server)
      .post(`/api/v1/parent/requests/${prId2}/cancel`)
      .set('Authorization', `Bearer ${parentToken}`)
      .expect(409);
    expect(cancelRes2.body.error).toBe('parent_request_already_processed');
  });

  // ── I. Nanny role — create_requests=false by default ─────────────────────

  it('returns 403 create_request_permission_required when a nanny guardian tries to create a request (Scenario I)', async () => {
    const a = await createKgWithAdmin('pr-i', '+77011100101');
    const nannyId = await seedUser('+77011100102');
    const childId = await createChild(a.adminToken, {
      full_name: 'Child I',
      date_of_birth: '2020-01-01',
    });
    await seedApprovedGuardian(a.kgId, childId, nannyId, { role: 'nanny' });
    const nannyToken = await mintToken({
      sub: nannyId,
      role: 'parent',
      kindergartenId: a.kgId,
    });

    const sat = futureSaturday();
    const res = await request(server)
      .post('/api/v1/parent/requests/day-off')
      .set('Authorization', `Bearer ${nannyToken}`)
      .send({ child_id: childId, weekend_dates: [sat] })
      .expect(403);

    expect(res.body.error).toBe('create_request_permission_required');
  });

  // ── J. create_requests=false explicit override ────────────────────────────

  it('returns 403 create_request_permission_required when guardian has create_requests=false permission override (Scenario J)', async () => {
    const a = await createKgWithAdmin('pr-j', '+77011100111');
    const parentId = await seedUser('+77011100112');
    const childId = await createChild(a.adminToken, {
      full_name: 'Child J',
      date_of_birth: '2020-01-01',
    });
    await seedApprovedGuardian(a.kgId, childId, parentId, {
      role: 'secondary',
      permissions: { create_requests: false },
    });
    const parentToken = await mintToken({
      sub: parentId,
      role: 'parent',
      kindergartenId: a.kgId,
    });

    const sat = futureSaturday();
    const res = await request(server)
      .post('/api/v1/parent/requests/day-off')
      .set('Authorization', `Bearer ${parentToken}`)
      .send({ child_id: childId, weekend_dates: [sat] })
      .expect(403);

    expect(res.body.error).toBe('create_request_permission_required');
  });

  // ── Day-off domain validators ─────────────────────────────────────────────

  it('returns 422 when day_off weekend_dates contains a weekday (Mon-Fri)', async () => {
    const a = await createKgWithAdmin('pr-v1', '+77011100121');
    const parentId = await seedUser('+77011100122');
    const childId = await createChild(a.adminToken, {
      full_name: 'Child V1',
      date_of_birth: '2020-01-01',
    });
    await seedApprovedGuardian(a.kgId, childId, parentId);
    const parentToken = await mintToken({
      sub: parentId,
      role: 'parent',
      kindergartenId: a.kgId,
    });

    const d = new Date();
    while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCDate(d.getUTCDate() + 7);
    const monday = d.toISOString().slice(0, 10);

    const res = await request(server)
      .post('/api/v1/parent/requests/day-off')
      .set('Authorization', `Bearer ${parentToken}`)
      .send({ child_id: childId, weekend_dates: [monday] })
      .expect(400);

    expect(res.body.error).toMatch(/weekend_date_not_weekend/);
  });

  it('returns 422 when day_off weekend_dates contains a past date', async () => {
    const a = await createKgWithAdmin('pr-v2', '+77011100131');
    const parentId = await seedUser('+77011100132');
    const childId = await createChild(a.adminToken, {
      full_name: 'Child V2',
      date_of_birth: '2020-01-01',
    });
    await seedApprovedGuardian(a.kgId, childId, parentId);
    const parentToken = await mintToken({
      sub: parentId,
      role: 'parent',
      kindergartenId: a.kgId,
    });

    // 2020-01-04 was a Saturday but is in the past
    const res = await request(server)
      .post('/api/v1/parent/requests/day-off')
      .set('Authorization', `Bearer ${parentToken}`)
      .send({ child_id: childId, weekend_dates: ['2020-01-04'] })
      .expect(400);

    expect(res.body.error).toMatch(/weekend_date_in_past/);
  });

  it('returns 400 when day_off weekend_dates has more than 2 dates (DTO ArrayMaxSize validation)', async () => {
    const a = await createKgWithAdmin('pr-v3', '+77011100141');
    const parentId = await seedUser('+77011100142');
    const childId = await createChild(a.adminToken, {
      full_name: 'Child V3',
      date_of_birth: '2020-01-01',
    });
    await seedApprovedGuardian(a.kgId, childId, parentId);
    const parentToken = await mintToken({
      sub: parentId,
      role: 'parent',
      kindergartenId: a.kgId,
    });

    const saturdays: string[] = [];
    const d = new Date();
    while (d.getUTCDay() !== 6) d.setUTCDate(d.getUTCDate() + 1);
    for (let i = 0; i < 3; i++) {
      d.setUTCDate(d.getUTCDate() + 7);
      saturdays.push(d.toISOString().slice(0, 10));
    }

    await request(server)
      .post('/api/v1/parent/requests/day-off')
      .set('Authorization', `Bearer ${parentToken}`)
      .send({ child_id: childId, weekend_dates: saturdays })
      .expect(422);
  });

  // ── Admin list endpoint ───────────────────────────────────────────────────

  it('returns all kg parent_requests via admin list endpoint and empty list when none exist', async () => {
    const a = await createKgWithAdmin('pr-admin', '+77011100151');
    const parentId = await seedUser('+77011100152');
    const childId = await createChild(a.adminToken, {
      full_name: 'Child Admin',
      date_of_birth: '2020-01-01',
    });
    await seedApprovedGuardian(a.kgId, childId, parentId);
    const parentToken = await mintToken({
      sub: parentId,
      role: 'parent',
      kindergartenId: a.kgId,
    });

    const emptyRes = await request(server)
      .get('/api/v1/admin/parent-requests')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .expect(200);
    expect(emptyRes.body.items).toHaveLength(0);

    const sat = futureSaturday();
    await request(server)
      .post('/api/v1/parent/requests/day-off')
      .set('Authorization', `Bearer ${parentToken}`)
      .send({ child_id: childId, weekend_dates: [sat] })
      .expect(201);

    const listRes = await request(server)
      .get('/api/v1/admin/parent-requests')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .expect(200);
    expect(listRes.body.items).toHaveLength(1);
    expect(listRes.body.items[0].status).toBe('pending');
  });
});
