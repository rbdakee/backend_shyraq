/**
 * B8 attendance e2e — exercises staff check-in/out, staff PATCH, admin
 * attendance oversight, daily-status, dashboard, and cross-tenant RLS
 * isolation.
 *
 * Endpoints under test:
 *   Staff:
 *     POST   /api/v1/staff/attendance/check-in
 *     POST   /api/v1/staff/attendance/check-out
 *     PATCH  /api/v1/staff/attendance/:eventId
 *     POST   /api/v1/staff/daily-status
 *   Admin:
 *     GET    /api/v1/admin/attendance-events
 *     GET    /api/v1/admin/attendance-events/:eventId
 *     PATCH  /api/v1/admin/attendance-events/:eventId
 *     GET    /api/v1/admin/dashboard/attendance-today
 *     GET    /api/v1/admin/daily-status
 *   Parent:
 *     GET    /api/v1/parent/children/:childId/attendance
 *     GET    /api/v1/parent/children/:childId/daily-status
 *
 * Error codes asserted:
 *   pickup_user_not_allowed       → 403
 *   attendance_edit_window_expired → 403 (non-admin same-day gate)
 *   attendance_event_not_found    → 404
 *
 * Scenarios A–H.
 */
import type { Server } from 'node:http';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createTestApp, flushRedis, TestApp, truncateAll } from './helpers/app';

const SUPER_ADMIN_EMAIL = 'super-attendance@shyraq.test';
const SUPER_ADMIN_PASSWORD = 'admin12345';

interface CreatedKgResp {
  kindergarten: { id: string; slug: string };
  staff_member: { id: string; user_id: string };
  user: { id: string; phone: string };
}

describe('B8 attendance (e2e)', () => {
  let ctx: TestApp;
  let server: Server;
  let saAccess: string;
  let jwtService: JwtService;
  let jwtSecret: string;

  // ── helpers ───────────────────────────────────────────────────────────────

  async function mintAdminAccess(opts: {
    sub: string;
    kindergartenId: string;
  }): Promise<string> {
    return jwtService.signAsync(
      {
        sub: opts.sub,
        role: 'admin',
        kindergarten_id: opts.kindergartenId,
        jti: randomUUID(),
      },
      { secret: jwtSecret, expiresIn: '1h' },
    );
  }

  async function mintStaffAccess(opts: {
    sub: string;
    kindergartenId: string;
    role?: string;
  }): Promise<string> {
    return jwtService.signAsync(
      {
        sub: opts.sub,
        role: opts.role ?? 'mentor',
        kindergarten_id: opts.kindergartenId,
        jti: randomUUID(),
      },
      { secret: jwtSecret, expiresIn: '1h' },
    );
  }

  async function mintParentAccess(opts: {
    sub: string;
    kindergartenId: string;
  }): Promise<string> {
    return jwtService.signAsync(
      {
        sub: opts.sub,
        role: 'parent',
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
        name: 'Attendance-Test KG',
        slug,
        admin: { full_name: 'Admin', phone },
      })
      .expect(201);
    const body = res.body as CreatedKgResp;
    const adminToken = await mintAdminAccess({
      sub: body.user.id,
      kindergartenId: body.kindergarten.id,
    });
    const staffToken = await mintStaffAccess({
      sub: body.user.id,
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
    childId: string,
    userId: string,
    kgId: string,
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

  // ── A. Staff check-in — happy path ────────────────────────────────────────

  it('returns 201 with event on check-in, sets daily status to present (Scenario A)', async () => {
    const a = await createKgWithAdmin('att-a', '+77011130001');
    const childId = await createChild(a.adminToken, {
      full_name: 'A-Child',
      date_of_birth: '2022-01-10',
    });

    const checkInRes = await request(server)
      .post('/api/v1/staff/attendance/check-in')
      .set('Authorization', `Bearer ${a.staffToken}`)
      .send({ childId })
      .expect(201);

    expect(checkInRes.body.childId).toBe(childId);
    expect(checkInRes.body.eventType).toBe('check_in');
    expect(checkInRes.body.id).toBeDefined();
    expect(checkInRes.body.recordedAt).toBeDefined();

    // Admin reads today's dashboard → child daily status is present
    const dashRes = await request(server)
      .get('/api/v1/admin/dashboard/attendance-today')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .expect(200);
    expect(Array.isArray(dashRes.body)).toBe(true);
    const record = (dashRes.body as { childId: string; status: string }[]).find(
      (r) => r.childId === childId,
    );
    expect(record).toBeDefined();
    expect(record?.status).toBe('present');
  });

  // ── B. Staff check-out — happy path + pickup validation ──────────────────

  it('returns 201 on check-out for approved pickup guardian and 403 for unknown user (Scenario B)', async () => {
    const a = await createKgWithAdmin('att-b', '+77011130002');
    const childId = await createChild(a.adminToken, {
      full_name: 'B-Child',
      date_of_birth: '2022-02-10',
    });

    // First check in
    await request(server)
      .post('/api/v1/staff/attendance/check-in')
      .set('Authorization', `Bearer ${a.staffToken}`)
      .send({ childId })
      .expect(201);

    // Seed a pickup guardian
    const pickupUserId = await seedUser('+77011130011');
    await seedApprovedGuardian(childId, pickupUserId, a.kgId, true);

    // Check out with approved pickup user → 201
    const checkOutRes = await request(server)
      .post('/api/v1/staff/attendance/check-out')
      .set('Authorization', `Bearer ${a.staffToken}`)
      .send({ childId, pickupUserId })
      .expect(201);
    expect(checkOutRes.body.eventType).toBe('check_out');
    expect(checkOutRes.body.pickupUserId).toBe(pickupUserId);

    // Check out with unknown user → 403 pickup_user_not_allowed
    const badPickupId = randomUUID();
    const deniedRes = await request(server)
      .post('/api/v1/staff/attendance/check-out')
      .set('Authorization', `Bearer ${a.staffToken}`)
      .send({ childId, pickupUserId: badPickupId });
    expect(deniedRes.status).toBe(403);
    expect(deniedRes.body.error).toBe('pickup_user_not_allowed');
  });

  // ── C. Admin GET attendance-events — list by child ────────────────────────

  it('returns 200 with attendance events list for admin (Scenario C)', async () => {
    const a = await createKgWithAdmin('att-c', '+77011130003');
    const childId = await createChild(a.adminToken, {
      full_name: 'C-Child',
      date_of_birth: '2022-03-10',
    });

    // Perform two check-ins
    await request(server)
      .post('/api/v1/staff/attendance/check-in')
      .set('Authorization', `Bearer ${a.staffToken}`)
      .send({ childId })
      .expect(201);

    const listRes = await request(server)
      .get('/api/v1/admin/attendance-events')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .query({ childId })
      .expect(200);

    expect(Array.isArray(listRes.body)).toBe(true);
    expect(listRes.body.length).toBeGreaterThanOrEqual(1);
    const ev = listRes.body[0] as { childId: string; eventType: string };
    expect(ev.childId).toBe(childId);
    expect(ev.eventType).toBe('check_in');
  });

  // ── D. Admin GET attendance-events/:eventId ───────────────────────────────

  it('returns 200 for known event id and 404 for unknown (Scenario D)', async () => {
    const a = await createKgWithAdmin('att-d', '+77011130004');
    const childId = await createChild(a.adminToken, {
      full_name: 'D-Child',
      date_of_birth: '2022-04-10',
    });

    const checkInRes = await request(server)
      .post('/api/v1/staff/attendance/check-in')
      .set('Authorization', `Bearer ${a.staffToken}`)
      .send({ childId })
      .expect(201);
    const eventId = checkInRes.body.id as string;

    // Known event → 200
    const getRes = await request(server)
      .get(`/api/v1/admin/attendance-events/${eventId}`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .expect(200);
    expect(getRes.body.id).toBe(eventId);

    // Unknown event → 404 attendance_event_not_found
    const notFoundRes = await request(server)
      .get(`/api/v1/admin/attendance-events/${randomUUID()}`)
      .set('Authorization', `Bearer ${a.adminToken}`);
    expect(notFoundRes.status).toBe(404);
    expect(notFoundRes.body.error).toBe('attendance_event_not_found');
  });

  // ── E. Admin PATCH — no edit-window restriction ───────────────────────────

  it('admin can patch a historical attendance event without edit-window error (Scenario E)', async () => {
    const a = await createKgWithAdmin('att-e', '+77011130005');
    const childId = await createChild(a.adminToken, {
      full_name: 'E-Child',
      date_of_birth: '2022-05-10',
    });

    // Create event with an old recordedAt (simulating historical data)
    const pastTime = '2026-01-15T08:30:00.000Z';
    const checkInRes = await request(server)
      .post('/api/v1/staff/attendance/check-in')
      .set('Authorization', `Bearer ${a.staffToken}`)
      .send({ childId, recordedAt: pastTime })
      .expect(201);
    const eventId = checkInRes.body.id as string;

    // Admin PATCH — should succeed even for historical date (no edit window)
    const patchRes = await request(server)
      .patch(`/api/v1/admin/attendance-events/${eventId}`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ notes: 'Admin correction' })
      .expect(200);
    expect(patchRes.body.id).toBe(eventId);
    expect(patchRes.body.notes).toBe('Admin correction');
  });

  // ── F. Staff PATCH — edit-window expired for historical event ────────────

  it('staff PATCH returns 403 attendance_edit_window_expired for historical event (Scenario F)', async () => {
    const a = await createKgWithAdmin('att-f', '+77011130006');
    const childId = await createChild(a.adminToken, {
      full_name: 'F-Child',
      date_of_birth: '2022-06-10',
    });

    // Create event on a past date
    const pastTime = '2026-01-15T08:30:00.000Z';
    const checkInRes = await request(server)
      .post('/api/v1/staff/attendance/check-in')
      .set('Authorization', `Bearer ${a.staffToken}`)
      .send({ childId, recordedAt: pastTime })
      .expect(201);
    const eventId = checkInRes.body.id as string;

    // Staff PATCH the historical event → 403 attendance_edit_window_expired
    const patchRes = await request(server)
      .patch(`/api/v1/staff/attendance/${eventId}`)
      .set('Authorization', `Bearer ${a.staffToken}`)
      .send({ notes: 'Should be rejected' });
    expect(patchRes.status).toBe(403);
    expect(patchRes.body.error).toBe('attendance_edit_window_expired');
  });

  // ── G. Staff daily-status upsert + parent reads it ───────────────────────

  it('staff sets daily status and parent can read it (Scenario G)', async () => {
    const a = await createKgWithAdmin('att-g', '+77011130007');
    const childId = await createChild(a.adminToken, {
      full_name: 'G-Child',
      date_of_birth: '2022-07-10',
    });

    const today = new Date().toLocaleDateString('en-CA', {
      timeZone: 'Asia/Almaty',
    });

    // Staff sets daily status to sick
    const statusRes = await request(server)
      .post('/api/v1/staff/daily-status')
      .set('Authorization', `Bearer ${a.staffToken}`)
      .send({ childId, date: today, status: 'sick', note: 'Температура 38' })
      .expect(200);
    expect(statusRes.body.childId).toBe(childId);
    expect(statusRes.body.status).toBe('sick');

    // Parent reads daily status
    const parentUserId = await seedUser('+77011130071');
    await seedApprovedGuardian(childId, parentUserId, a.kgId);
    const parentToken = await mintParentAccess({
      sub: parentUserId,
      kindergartenId: a.kgId,
    });

    const parentReadRes = await request(server)
      .get(`/api/v1/parent/children/${childId}/daily-status`)
      .set('Authorization', `Bearer ${parentToken}`)
      .query({ date: today })
      .expect(200);
    expect(parentReadRes.body.status).toBe('sick');
    expect(parentReadRes.body.childId).toBe(childId);
  });

  // ── H. Cross-tenant RLS isolation ────────────────────────────────────────

  it('hides KG-A attendance event from KG-B admin via RLS (Scenario H)', async () => {
    const a = await createKgWithAdmin('att-h-a', '+77011130008');
    const b = await createKgWithAdmin('att-h-b', '+77011130009');
    const childId = await createChild(a.adminToken, {
      full_name: 'H-Child',
      date_of_birth: '2022-08-10',
    });

    const checkInRes = await request(server)
      .post('/api/v1/staff/attendance/check-in')
      .set('Authorization', `Bearer ${a.staffToken}`)
      .send({ childId })
      .expect(201);
    const eventId = checkInRes.body.id as string;

    // KG-B admin tries to read KG-A event → 404 (RLS hides the row)
    const crossRes = await request(server)
      .get(`/api/v1/admin/attendance-events/${eventId}`)
      .set('Authorization', `Bearer ${b.adminToken}`);
    expect(crossRes.status).toBe(404);
    expect(crossRes.body.error).toBe('attendance_event_not_found');
  });

  // ── I. Parent attendance list ─────────────────────────────────────────────

  it('returns 200 with events for approved parent and 403 for non-guardian (Scenario I)', async () => {
    const a = await createKgWithAdmin('att-i', '+77011130010');
    const childId = await createChild(a.adminToken, {
      full_name: 'I-Child',
      date_of_birth: '2022-09-10',
    });

    // Check in the child
    await request(server)
      .post('/api/v1/staff/attendance/check-in')
      .set('Authorization', `Bearer ${a.staffToken}`)
      .send({ childId })
      .expect(201);

    // Approved parent → 200
    const parentUserId = await seedUser('+77011130101');
    await seedApprovedGuardian(childId, parentUserId, a.kgId);
    const parentToken = await mintParentAccess({
      sub: parentUserId,
      kindergartenId: a.kgId,
    });

    const okRes = await request(server)
      .get(`/api/v1/parent/children/${childId}/attendance`)
      .set('Authorization', `Bearer ${parentToken}`)
      .expect(200);
    expect(Array.isArray(okRes.body)).toBe(true);
    expect(okRes.body.length).toBeGreaterThanOrEqual(1);

    // Non-guardian parent → 403
    const otherUserId = await seedUser('+77011130102');
    const otherToken = await mintParentAccess({
      sub: otherUserId,
      kindergartenId: a.kgId,
    });
    const deniedRes = await request(server)
      .get(`/api/v1/parent/children/${childId}/attendance`)
      .set('Authorization', `Bearer ${otherToken}`);
    expect(deniedRes.status).toBe(403);
  });

  // ── K. Admin GET attendance-events without filters (T6 H1 fix) ──────────

  it('returns 200 with kg-wide events when neither childId nor groupId filter is set (Scenario K)', async () => {
    const a = await createKgWithAdmin('att-k', '+77011130013');
    const childId = await createChild(a.adminToken, {
      full_name: 'K-Child',
      date_of_birth: '2022-11-10',
    });
    await request(server)
      .post('/api/v1/staff/attendance/check-in')
      .set('Authorization', `Bearer ${a.staffToken}`)
      .send({ childId })
      .expect(201);

    const listRes = await request(server)
      .get('/api/v1/admin/attendance-events')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .expect(200);

    expect(Array.isArray(listRes.body)).toBe(true);
    expect(listRes.body.length).toBeGreaterThanOrEqual(1);
    const ev = listRes.body[0] as { childId: string; eventType: string };
    expect(ev.childId).toBe(childId);
  });

  // ── L. Dashboard groupId filter (T6 H2 fix) ──────────────────────────────

  it('honours ?groupId on /admin/dashboard/attendance-today (Scenario L)', async () => {
    const a = await createKgWithAdmin('att-l', '+77011130014');
    // Two groups + two children, each in a different group.
    const groupA = await request(server)
      .post('/api/v1/groups')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ name: 'Group-A', capacity: 20 })
      .expect(201);
    const groupB = await request(server)
      .post('/api/v1/groups')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ name: 'Group-B', capacity: 20 })
      .expect(201);
    const groupAId = groupA.body.id as string;
    const groupBId = groupB.body.id as string;

    const childA = await createChild(a.adminToken, {
      full_name: 'L-Child-A',
      date_of_birth: '2022-12-10',
    });
    const childB = await createChild(a.adminToken, {
      full_name: 'L-Child-B',
      date_of_birth: '2022-12-11',
    });

    // Assign children to groups via direct UPDATE (matches helper used by
    // schedule.e2e-spec / meal.e2e-spec for the same scenario).
    await ctx.dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      await m.query(`UPDATE children SET current_group_id = $1 WHERE id = $2`, [
        groupAId,
        childA,
      ]);
      await m.query(`UPDATE children SET current_group_id = $1 WHERE id = $2`, [
        groupBId,
        childB,
      ]);
    });

    // Both children get a daily_status row (sick) for today.
    const today = new Date().toLocaleDateString('en-CA', {
      timeZone: 'Asia/Almaty',
    });
    await request(server)
      .post('/api/v1/staff/daily-status')
      .set('Authorization', `Bearer ${a.staffToken}`)
      .send({ childId: childA, date: today, status: 'sick' })
      .expect(200);
    await request(server)
      .post('/api/v1/staff/daily-status')
      .set('Authorization', `Bearer ${a.staffToken}`)
      .send({ childId: childB, date: today, status: 'sick' })
      .expect(200);

    // Dashboard with ?groupId=groupA → only childA.
    const dashARes = await request(server)
      .get('/api/v1/admin/dashboard/attendance-today')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .query({ groupId: groupAId })
      .expect(200);
    const idsA = (dashARes.body as { childId: string }[]).map((r) => r.childId);
    expect(idsA).toContain(childA);
    expect(idsA).not.toContain(childB);

    // Dashboard with ?groupId=groupB → only childB.
    const dashBRes = await request(server)
      .get('/api/v1/admin/dashboard/attendance-today')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .query({ groupId: groupBId })
      .expect(200);
    const idsB = (dashBRes.body as { childId: string }[]).map((r) => r.childId);
    expect(idsB).toContain(childB);
    expect(idsB).not.toContain(childA);
  });

  // ── M. Parent daily-status garbage date validation (T6 M1 fix) ──────────

  it('returns 400 for parent daily-status with malformed date (Scenario M)', async () => {
    const a = await createKgWithAdmin('att-m', '+77011130015');
    const childId = await createChild(a.adminToken, {
      full_name: 'M-Child',
      date_of_birth: '2022-12-12',
    });
    const parentUserId = await seedUser('+77011130150');
    await seedApprovedGuardian(childId, parentUserId, a.kgId);
    const parentToken = await mintParentAccess({
      sub: parentUserId,
      kindergartenId: a.kgId,
    });

    // Garbage date → 422 (global ValidationPipe config maps validation errors
    // to UnprocessableEntity per src/utils/validation-options.ts). Previously
    // the controller read a raw string which leaked all the way to PG and
    // crashed with `invalid input syntax for type date` (T6 M1).
    const badRes = await request(server)
      .get(`/api/v1/parent/children/${childId}/daily-status`)
      .set('Authorization', `Bearer ${parentToken}`)
      .query({ date: 'garbage' });
    expect(badRes.status).toBe(422);

    // Valid date with no row → 200 with null/empty body (controller returns
    // null which Express serialises as either `null` or `{}` depending on
    // version; we accept both).
    const okRes = await request(server)
      .get(`/api/v1/parent/children/${childId}/daily-status`)
      .set('Authorization', `Bearer ${parentToken}`)
      .query({ date: '2099-01-01' })
      .expect(200);
    const isEmpty =
      okRes.body === null ||
      (typeof okRes.body === 'object' && Object.keys(okRes.body).length === 0);
    expect(isEmpty).toBe(true);
  });

  // ── N. Cross-tenant daily_status RLS isolation (T6 M4 fix) ──────────────

  it('hides KG-A daily_status row from KG-B admin via RLS (Scenario N)', async () => {
    const a = await createKgWithAdmin('att-n-a', '+77011130016');
    const b = await createKgWithAdmin('att-n-b', '+77011130017');
    const childA = await createChild(a.adminToken, {
      full_name: 'N-Child-A',
      date_of_birth: '2022-12-13',
    });
    const today = new Date().toLocaleDateString('en-CA', {
      timeZone: 'Asia/Almaty',
    });
    // KG-A staff sets a daily_status row for KG-A child.
    await request(server)
      .post('/api/v1/staff/daily-status')
      .set('Authorization', `Bearer ${a.staffToken}`)
      .send({ childId: childA, date: today, status: 'sick' })
      .expect(200);

    // KG-B admin lists daily statuses → must NOT see KG-A's row.
    const listRes = await request(server)
      .get('/api/v1/admin/daily-status')
      .set('Authorization', `Bearer ${b.adminToken}`)
      .query({ from: today, to: today })
      .expect(200);
    expect(Array.isArray(listRes.body)).toBe(true);
    const ids = (listRes.body as { childId: string }[]).map((r) => r.childId);
    expect(ids).not.toContain(childA);

    // KG-B staff trying to set daily_status for KG-A child → 404 (RLS hides
    // the child row from KG-B's tenant scope, so ChildNotFoundError fires).
    // Note: ChildNotFoundError extends NotFoundError whose code is the
    // generic `not_found` (see src/shared-kernel/domain/errors/not-found.error.ts).
    const crossSetRes = await request(server)
      .post('/api/v1/staff/daily-status')
      .set('Authorization', `Bearer ${b.staffToken}`)
      .send({ childId: childA, date: today, status: 'present' });
    expect(crossSetRes.status).toBe(404);
    expect(crossSetRes.body.error).toBe('not_found');
  });

  // ── J. Admin daily-status list ────────────────────────────────────────────

  it('returns 200 with daily-status list on GET /admin/daily-status (Scenario J)', async () => {
    const a = await createKgWithAdmin('att-j', '+77011130012');
    const childId = await createChild(a.adminToken, {
      full_name: 'J-Child',
      date_of_birth: '2022-10-10',
    });

    const today = new Date().toLocaleDateString('en-CA', {
      timeZone: 'Asia/Almaty',
    });

    // Set daily status
    await request(server)
      .post('/api/v1/staff/daily-status')
      .set('Authorization', `Bearer ${a.staffToken}`)
      .send({ childId, date: today, status: 'present' })
      .expect(200);

    // Admin lists daily statuses
    const listRes = await request(server)
      .get('/api/v1/admin/daily-status')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .query({ from: today, to: today })
      .expect(200);

    expect(Array.isArray(listRes.body)).toBe(true);
    const record = (
      listRes.body as { childId: string; status: string; date: string }[]
    ).find((r) => r.childId === childId);
    expect(record).toBeDefined();
    expect(record?.status).toBe('present');
  });
});
