/**
 * B8 attendance e2e — exercises staff check-in/out, staff PATCH, admin
 * attendance oversight + register-keeping, daily-status, dashboard, audit
 * history, and cross-tenant RLS isolation.
 *
 * Endpoints under test:
 *   Staff:
 *     POST   /api/v1/staff/attendance/check-in
 *     POST   /api/v1/staff/attendance/check-out
 *     PATCH  /api/v1/staff/attendance/:eventId
 *     POST   /api/v1/staff/daily-status
 *   Admin:
 *     POST   /api/v1/admin/attendance/check-in
 *     GET    /api/v1/admin/attendance-events
 *     GET    /api/v1/admin/attendance-events/:eventId
 *     PATCH  /api/v1/admin/attendance-events/:eventId
 *     DELETE /api/v1/admin/attendance-events/:eventId
 *     GET    /api/v1/admin/attendance-events/:eventId/history
 *     GET    /api/v1/admin/dashboard/attendance-today
 *     POST   /api/v1/admin/daily-status
 *     GET    /api/v1/admin/daily-status
 *     GET    /api/v1/admin/children/:childId/timeline
 *   Parent:
 *     GET    /api/v1/parent/children/:childId/attendance
 *     GET    /api/v1/parent/children/:childId/daily-status
 *
 * Error codes asserted:
 *   pickup_user_not_allowed       → 403
 *   attendance_edit_window_expired → 403 (non-admin same-day gate)
 *   attendance_event_not_found    → 404 (unknown id, and re-delete of a
 *                                        soft-deleted one)
 *
 * Scenarios A–S (A–N as before; O–S cover the admin register):
 *   O — admin check-in lands in the events list.
 *   P — admin DELETE tombstones the event: it leaves BOTH the events list and
 *       the dashboard donut. This is the regression guard for the
 *       `deleted_at IS NULL` filters (a missed one leaks deleted events into
 *       the counters, which no unit test can catch — the donut is raw SQL).
 *   Q — admin PATCH childId moves the paired timeline entry between children.
 *   R — audit history returns create+update+delete newest-first.
 *   S — admin daily-status upsert returns 200.
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
    // Identity overlay: the recorder is the seeded admin user (full_name
    // 'Admin'); check-in carries no pickup user.
    expect(checkInRes.body).toHaveProperty('recorded_by_full_name');
    expect(checkInRes.body.recorded_by_full_name).toBe('Admin');
    expect(checkInRes.body).toHaveProperty('pickup_user_full_name');
    expect(checkInRes.body.pickup_user_full_name).toBeNull();

    // Admin reads today's daily-status list → child daily status is present.
    // (The dashboard/attendance-today route was reworked into an aggregate
    // donut in B-DASH; the per-child array now lives on GET /admin/daily-status.)
    const dashRes = await request(server)
      .get('/api/v1/admin/daily-status')
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
    // Identity-overlay fields are present. The pickup user was seeded with an
    // empty full_name, which the overlay collapses to null.
    expect(checkOutRes.body).toHaveProperty('pickup_user_full_name');
    expect(checkOutRes.body.pickup_user_full_name).toBeNull();
    expect(checkOutRes.body).toHaveProperty('recorded_by_full_name');
    expect(checkOutRes.body.recorded_by_full_name).toBe('Admin');

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
    const ev = listRes.body[0] as {
      childId: string;
      eventType: string;
      recorded_by_full_name: string | null;
      pickup_user_full_name: string | null;
    };
    expect(ev.childId).toBe(childId);
    expect(ev.eventType).toBe('check_in');
    // Identity-overlay fields present on every listed event.
    expect(ev).toHaveProperty('recorded_by_full_name');
    expect(ev).toHaveProperty('pickup_user_full_name');
    expect(ev.recorded_by_full_name).toBe('Admin');
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
    // Identity overlay: the status was set by the seeded admin user.
    expect(parentReadRes.body).toHaveProperty('set_by_full_name');
    expect(parentReadRes.body.set_by_full_name).toBe('Admin');
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
    // Identity-overlay fields present on parent-visible events.
    expect(okRes.body[0]).toHaveProperty('recorded_by_full_name');
    expect(okRes.body[0]).toHaveProperty('pickup_user_full_name');
    expect(okRes.body[0].recorded_by_full_name).toBe('Admin');

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
      listRes.body as {
        childId: string;
        status: string;
        date: string;
        set_by_full_name: string | null;
      }[]
    ).find((r) => r.childId === childId);
    expect(record).toBeDefined();
    expect(record?.status).toBe('present');
    // Identity overlay present on each daily-status row.
    expect(record).toHaveProperty('set_by_full_name');
    expect(record?.set_by_full_name).toBe('Admin');
  });

  // ── O. Admin records a check-in from the admin panel ─────────────────────

  it('returns 201 on admin check-in and lists the event (Scenario O)', async () => {
    const a = await createKgWithAdmin('att-o', '+77011130018');
    const childId = await createChild(a.adminToken, {
      full_name: 'O-Child',
      date_of_birth: '2022-01-20',
    });

    const checkInRes = await request(server)
      .post('/api/v1/admin/attendance/check-in')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ childId })
      .expect(201);
    expect(checkInRes.body.childId).toBe(childId);
    expect(checkInRes.body.eventType).toBe('check_in');
    expect(checkInRes.body.recorded_by_full_name).toBe('Admin');
    expect(checkInRes.body.child_name).toBe('O-Child');

    const listRes = await request(server)
      .get('/api/v1/admin/attendance-events')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .query({ childId })
      .expect(200);
    const ids = (listRes.body as { id: string }[]).map((e) => e.id);
    expect(ids).toContain(checkInRes.body.id);
  });

  // ── P. Admin DELETE — event leaves the list AND the dashboard counters ────

  it('returns 204 on admin delete and drops the event from the list and dashboard (Scenario P)', async () => {
    const a = await createKgWithAdmin('att-p', '+77011130019');
    const childId = await createChild(a.adminToken, {
      full_name: 'P-Child',
      date_of_birth: '2022-02-20',
    });

    const checkInRes = await request(server)
      .post('/api/v1/admin/attendance/check-in')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ childId })
      .expect(201);
    const eventId = checkInRes.body.id as string;

    // The child is in the kindergarten per the donut before the delete.
    const beforeDash = await request(server)
      .get('/api/v1/admin/dashboard/attendance-today')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .expect(200);
    expect(beforeDash.body.in_kindergarten).toBe(1);

    await request(server)
      .delete(`/api/v1/admin/attendance-events/${eventId}`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .expect(204);

    // Gone from the events list…
    const listRes = await request(server)
      .get('/api/v1/admin/attendance-events')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .query({ childId })
      .expect(200);
    expect((listRes.body as { id: string }[]).map((e) => e.id)).not.toContain(
      eventId,
    );

    // …and from the single-event read.
    const getRes = await request(server)
      .get(`/api/v1/admin/attendance-events/${eventId}`)
      .set('Authorization', `Bearer ${a.adminToken}`);
    expect(getRes.status).toBe(404);
    expect(getRes.body.error).toBe('attendance_event_not_found');

    // …and from the dashboard donut. The counter is computed by a raw
    // DISTINCT ON query, so this is the only place a missed `deleted_at IS
    // NULL` would surface.
    const afterDash = await request(server)
      .get('/api/v1/admin/dashboard/attendance-today')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .expect(200);
    expect(afterDash.body.in_kindergarten).toBe(0);

    // The child's day falls back from present to absent (no live check_in).
    const today = new Date().toLocaleDateString('en-CA', {
      timeZone: 'Asia/Almaty',
    });
    const statusRes = await request(server)
      .get('/api/v1/admin/daily-status')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .query({ from: today, to: today })
      .expect(200);
    const row = (statusRes.body as { childId: string; status: string }[]).find(
      (r) => r.childId === childId,
    );
    expect(row?.status).toBe('absent');

    // Re-deleting a tombstone is a 404, not a silent no-op.
    const reDeleteRes = await request(server)
      .delete(`/api/v1/admin/attendance-events/${eventId}`)
      .set('Authorization', `Bearer ${a.adminToken}`);
    expect(reDeleteRes.status).toBe(404);
    expect(reDeleteRes.body.error).toBe('attendance_event_not_found');
  });

  // ── Q. Admin PATCH childId — the timeline entry moves with the event ─────

  it('moves the timeline entry to the new child on admin PATCH childId (Scenario Q)', async () => {
    const a = await createKgWithAdmin('att-q', '+77011130020');
    const childA = await createChild(a.adminToken, {
      full_name: 'Q-Child-A',
      date_of_birth: '2022-03-20',
    });
    const childB = await createChild(a.adminToken, {
      full_name: 'Q-Child-B',
      date_of_birth: '2022-03-21',
    });

    const checkInRes = await request(server)
      .post('/api/v1/admin/attendance/check-in')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ childId: childA })
      .expect(201);
    const eventId = checkInRes.body.id as string;

    // Filed against the wrong kid — the entry sits on child A for now.
    const beforeA = await request(server)
      .get(`/api/v1/admin/children/${childA}/timeline`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .expect(200);
    expect(beforeA.body.items).toHaveLength(1);
    expect(beforeA.body.items[0].entryType).toBe('check_in');

    const patchRes = await request(server)
      .patch(`/api/v1/admin/attendance-events/${eventId}`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ childId: childB })
      .expect(200);
    expect(patchRes.body.childId).toBe(childB);
    expect(patchRes.body.child_name).toBe('Q-Child-B');

    // Child A's timeline is now empty…
    const afterA = await request(server)
      .get(`/api/v1/admin/children/${childA}/timeline`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .expect(200);
    expect(afterA.body.items).toHaveLength(0);

    // …and child B carries the entry.
    const afterB = await request(server)
      .get(`/api/v1/admin/children/${childB}/timeline`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .expect(200);
    expect(afterB.body.items).toHaveLength(1);
    expect(afterB.body.items[0].entryType).toBe('check_in');
    expect(afterB.body.items[0].childId).toBe(childB);
  });

  // ── R. Audit history — create + update + delete, newest first ─────────────

  it('returns the correction history newest-first after create+update+delete (Scenario R)', async () => {
    const a = await createKgWithAdmin('att-r', '+77011130021');
    const childId = await createChild(a.adminToken, {
      full_name: 'R-Child',
      date_of_birth: '2022-04-20',
    });

    const checkInRes = await request(server)
      .post('/api/v1/admin/attendance/check-in')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ childId })
      .expect(201);
    const eventId = checkInRes.body.id as string;

    await request(server)
      .patch(`/api/v1/admin/attendance-events/${eventId}`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ notes: 'corrected by admin' })
      .expect(200);

    await request(server)
      .delete(`/api/v1/admin/attendance-events/${eventId}`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .expect(204);

    // History outlives the row — the id is a tombstone by now.
    const histRes = await request(server)
      .get(`/api/v1/admin/attendance-events/${eventId}/history`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .expect(200);

    const entries = histRes.body as {
      action: string;
      actor_full_name: string | null;
      actorUserId: string | null;
      before: Record<string, unknown> | null;
      after: Record<string, unknown> | null;
    }[];
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.action)).toEqual([
      'delete',
      'update',
      'create',
    ]);

    // create → after only.
    const create = entries[2];
    expect(create.before).toBeNull();
    expect(create.after).toMatchObject({ childId, eventType: 'check_in' });

    // update → both, carrying the notes move.
    const update = entries[1];
    expect(update.before).toMatchObject({ notes: null });
    expect(update.after).toMatchObject({ notes: 'corrected by admin' });

    // delete → before only, snapshotted while the row was still live.
    const del = entries[0];
    expect(del.before).toMatchObject({ id: eventId, deletedAt: null });
    expect(del.after).toBeNull();

    // Identity overlay + actor id on every entry.
    for (const e of entries) {
      expect(e.actor_full_name).toBe('Admin');
      expect(e.actorUserId).toBe(a.userId);
    }
  });

  // ── S. Admin daily-status upsert ─────────────────────────────────────────

  it('returns 200 on admin daily-status upsert (Scenario S)', async () => {
    const a = await createKgWithAdmin('att-s', '+77011130022');
    const childId = await createChild(a.adminToken, {
      full_name: 'S-Child',
      date_of_birth: '2022-05-20',
    });
    const today = new Date().toLocaleDateString('en-CA', {
      timeZone: 'Asia/Almaty',
    });

    const res = await request(server)
      .post('/api/v1/admin/daily-status')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ childId, date: today, status: 'sick', note: 'Температура 38' })
      .expect(200);
    expect(res.body.childId).toBe(childId);
    expect(res.body.status).toBe('sick');
    expect(res.body.note).toBe('Температура 38');
    expect(res.body.set_by_full_name).toBe('Admin');

    // Upsert — a second call on the same (child, date) overrides in place.
    const overrideRes = await request(server)
      .post('/api/v1/admin/daily-status')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ childId, date: today, status: 'on_vacation' })
      .expect(200);
    expect(overrideRes.body.status).toBe('on_vacation');

    const listRes = await request(server)
      .get('/api/v1/admin/daily-status')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .query({ from: today, to: today })
      .expect(200);
    const rows = (listRes.body as { childId: string }[]).filter(
      (r) => r.childId === childId,
    );
    expect(rows).toHaveLength(1);
  });

  /**
   * The admin-attendance controller is @Roles('admin','reception') at the
   * class level, so reception reaches these routes. It keeps the ordinary
   * patch (incl. the edit-window bypass — correcting an earlier day is what
   * the route is for), but must NOT get the admin-only powers: re-pointing an
   * event onto another child, flipping its direction, or deleting it.
   *
   * This is the regression guard for exactly that: DELETE is narrowed by a
   * method-level @Roles('admin'), and the structural fields are gated on the
   * caller's real role rather than on the route.
   */
  it('rejects reception attempting the admin-only corrections while allowing its ordinary patch (Scenario T)', async () => {
    const a = await createKgWithAdmin('att-t', '+77011130023');
    const receptionToken = await mintStaffAccess({
      sub: a.userId,
      kindergartenId: a.kgId,
      role: 'reception',
    });
    const childId = await createChild(a.adminToken, {
      full_name: 'T-Child',
      date_of_birth: '2022-03-10',
    });
    const otherChildId = await createChild(a.adminToken, {
      full_name: 'T-Other',
      date_of_birth: '2022-04-11',
    });

    const created = await request(server)
      .post('/api/v1/admin/attendance/check-in')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ childId })
      .expect(201);
    const eventId = created.body.id as string;

    // Structural correction → 403 attendance_correction_admin_only.
    await request(server)
      .patch(`/api/v1/admin/attendance-events/${eventId}`)
      .set('Authorization', `Bearer ${receptionToken}`)
      .send({ childId: otherChildId })
      .expect(403);

    await request(server)
      .patch(`/api/v1/admin/attendance-events/${eventId}`)
      .set('Authorization', `Bearer ${receptionToken}`)
      .send({ eventType: 'check_out' })
      .expect(403);

    // DELETE → 403 insufficient_role (method-level @Roles('admin')).
    await request(server)
      .delete(`/api/v1/admin/attendance-events/${eventId}`)
      .set('Authorization', `Bearer ${receptionToken}`)
      .expect(403);

    // The event survived all three attempts, unchanged.
    const stillThere = await request(server)
      .get(`/api/v1/admin/attendance-events/${eventId}`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .expect(200);
    expect(stillThere.body.childId).toBe(childId);
    expect(stillThere.body.eventType).toBe('check_in');

    // …but reception's ordinary patch still works.
    const patched = await request(server)
      .patch(`/api/v1/admin/attendance-events/${eventId}`)
      .set('Authorization', `Bearer ${receptionToken}`)
      .send({ notes: 'reception note' })
      .expect(200);
    expect(patched.body.notes).toBe('reception note');
  });
});
