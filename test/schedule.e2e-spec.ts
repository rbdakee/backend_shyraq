/**
 * B7 schedule e2e — exercises admin/staff/parent surfaces for schedule
 * templates, slots, activity events, week-copy, ChildAccessGuard, and
 * cross-tenant RLS isolation.
 *
 * Endpoints under test:
 *   Admin:
 *     POST   /api/v1/admin/schedule/templates
 *     GET    /api/v1/admin/schedule/templates/:id
 *     PATCH  /api/v1/admin/schedule/templates/:id
 *     DELETE /api/v1/admin/schedule/templates/:id
 *     POST   /api/v1/admin/schedule/templates/:id/slots
 *     PATCH  /api/v1/admin/schedule/templates/:id/slots/:slotId
 *     DELETE /api/v1/admin/schedule/templates/:id/slots/:slotId
 *     POST   /api/v1/admin/schedule/activity-events
 *     PATCH  /api/v1/admin/schedule/activity-events/:id
 *     DELETE /api/v1/admin/schedule/activity-events/:id
 *     POST   /api/v1/admin/schedule/week-snapshots/copy
 *   Staff:
 *     POST   /api/v1/staff/schedule/activity-events/:id/start
 *     POST   /api/v1/staff/schedule/activity-events/:id/complete
 *     POST   /api/v1/staff/schedule/activity-events/:id/cancel
 *   Parent:
 *     GET    /api/v1/parent/children/:childId/schedule
 *
 * Error codes asserted:
 *   slot_time_conflict          → 409
 *   activity_event_not_deletable → 409
 *   invalid_activity_event_transition → 409
 *
 * Scenarios A–H (see brief T6).
 */
import type { Server } from 'node:http';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createTestApp, flushRedis, TestApp, truncateAll } from './helpers/app';

const SUPER_ADMIN_EMAIL = 'super-schedule@shyraq.test';
const SUPER_ADMIN_PASSWORD = 'admin12345';

interface CreatedKgResp {
  kindergarten: { id: string; slug: string };
  staff_member: { id: string; user_id: string };
  user: { id: string; phone: string };
}

describe('B7 schedule (e2e)', () => {
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
  }> {
    const res = await request(server)
      .post('/api/v1/saas/kindergartens')
      .set('Authorization', `Bearer ${saAccess}`)
      .send({
        name: 'Schedule-Test KG',
        slug,
        admin: { full_name: 'Admin', phone },
      })
      .expect(201);
    const body = res.body as CreatedKgResp;
    const adminToken = await mintAdminAccess({
      sub: body.user.id,
      kindergartenId: body.kindergarten.id,
    });
    return {
      kgId: body.kindergarten.id,
      userId: body.user.id,
      staffMemberId: body.staff_member.id,
      adminToken,
    };
  }

  async function createGroup(
    adminToken: string,
    name = 'Арлар',
  ): Promise<string> {
    const res = await request(server)
      .post('/api/v1/groups')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name, capacity: 20 })
      .expect(201);
    return res.body.id as string;
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

  /** Create a child via admin path and return the childId. */
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

  /**
   * Seed an approved guardian row directly in the DB so a parent token
   * can pass ChildAccessGuard without going through the full OTP flow.
   */
  async function seedApprovedGuardian(
    childId: string,
    userId: string,
    kgId: string,
  ): Promise<void> {
    await ctx.dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      await m.query(
        `INSERT INTO child_guardians
           (id, kindergarten_id, child_id, user_id, role, status, approved_by, approved_at)
         VALUES ($1, $2, $3, $4, 'primary', 'approved', $4, now())`,
        [randomUUID(), kgId, childId, userId],
      );
    });
  }

  /** Assign child to a group by updating children.current_group_id. */
  async function assignChildToGroup(
    childId: string,
    groupId: string,
  ): Promise<void> {
    await ctx.dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      await m.query(
        `UPDATE children SET current_group_id = $1 WHERE id = $2`,
        [groupId, childId],
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

  // ── A. Admin template CRUD + slot conflict ───────────────────────────────

  it('returns 201 on template create, 409 on slot conflict, 200 on update/delete (Scenario A)', async () => {
    const a = await createKgWithAdmin('sch-a', '+77011120101');
    const grpId = await createGroup(a.adminToken);

    // Create template → 201
    const tplRes = await request(server)
      .post('/api/v1/admin/schedule/templates')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({
        groupId: grpId,
        name: 'Standard Mon-Fri',
        validFrom: '2026-05-04',
        isActive: true,
      })
      .expect(201);
    const tplId = tplRes.body.id as string;
    expect(tplRes.body.name).toBe('Standard Mon-Fri');

    // Add slot Mon 09:00-10:00 → 201
    const slot1Res = await request(server)
      .post(`/api/v1/admin/schedule/templates/${tplId}/slots`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({
        dayOfWeek: 'mon',
        startTime: '09:00',
        endTime: '10:00',
        activityName: 'Утренний круг',
      })
      .expect(201);
    expect(slot1Res.body.slots).toBeDefined();
    const slot1Id = slot1Res.body.slots[0].id as string;

    // Add overlapping slot Mon 09:00-11:00 → 409 slot_time_conflict
    const conflictRes = await request(server)
      .post(`/api/v1/admin/schedule/templates/${tplId}/slots`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({
        dayOfWeek: 'mon',
        startTime: '09:00',
        endTime: '11:00',
        activityName: 'Конфликт',
      });
    expect(conflictRes.status).toBe(409);
    expect(conflictRes.body.error).toBe('slot_time_conflict');

    // Update slot → 200
    const updateSlotRes = await request(server)
      .patch(`/api/v1/admin/schedule/templates/${tplId}/slots/${slot1Id}`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({
        dayOfWeek: 'mon',
        startTime: '09:00',
        endTime: '09:45',
        activityName: 'Утренний круг обновлён',
      })
      .expect(200);
    expect(
      updateSlotRes.body.slots.find((s: { id: string }) => s.id === slot1Id)
        ?.activityName,
    ).toBe('Утренний круг обновлён');

    // Delete slot → 204
    await request(server)
      .delete(`/api/v1/admin/schedule/templates/${tplId}/slots/${slot1Id}`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .expect(204);

    // Delete template → 204
    await request(server)
      .delete(`/api/v1/admin/schedule/templates/${tplId}`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .expect(204);

    // GET deleted template → 404
    const gone = await request(server)
      .get(`/api/v1/admin/schedule/templates/${tplId}`)
      .set('Authorization', `Bearer ${a.adminToken}`);
    expect(gone.status).toBe(404);
  });

  // ── B. Activity-event CRUD + delete-only-when-scheduled 409 ─────────────

  it('rejects DELETE of in_progress event with code activity_event_not_deletable (Scenario B)', async () => {
    const a = await createKgWithAdmin('sch-b', '+77011120102');
    const grpId = await createGroup(a.adminToken);

    // Create ad-hoc event → 201
    const evRes = await request(server)
      .post('/api/v1/admin/schedule/activity-events')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({
        groupId: grpId,
        activityName: 'Прогулка',
        startsAt: '2026-05-04T09:00:00.000Z',
        endsAt: '2026-05-04T09:45:00.000Z',
      })
      .expect(201);
    const evId = evRes.body.id as string;
    expect(evRes.body.status).toBe('scheduled');

    // PATCH while scheduled → 200
    await request(server)
      .patch(`/api/v1/admin/schedule/activity-events/${evId}`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ activityName: 'Прогулка (обновлено)' })
      .expect(200);

    // Staff start → in_progress
    const staffToken = await mintStaffAccess({
      sub: a.userId,
      kindergartenId: a.kgId,
    });
    await request(server)
      .post(`/api/v1/staff/schedule/activity-events/${evId}/start`)
      .set('Authorization', `Bearer ${staffToken}`)
      .expect(200);

    // DELETE while in_progress → 409 activity_event_not_deletable
    const delRes = await request(server)
      .delete(`/api/v1/admin/schedule/activity-events/${evId}`)
      .set('Authorization', `Bearer ${a.adminToken}`);
    expect(delRes.status).toBe(409);
    expect(delRes.body.error).toBe('activity_event_not_deletable');
  });

  // ── C. Staff state-machine ─────────────────────────────────────────────

  it('rejects invalid state-machine transitions (Scenario C)', async () => {
    const a = await createKgWithAdmin('sch-c', '+77011120103');
    const grpId = await createGroup(a.adminToken);
    const staffToken = await mintStaffAccess({
      sub: a.userId,
      kindergartenId: a.kgId,
    });

    // Create event (admin)
    const evRes = await request(server)
      .post('/api/v1/admin/schedule/activity-events')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({
        groupId: grpId,
        activityName: 'Рисование',
        startsAt: '2026-05-05T10:00:00.000Z',
      })
      .expect(201);
    const evId = evRes.body.id as string;

    // Staff start → in_progress
    const startRes = await request(server)
      .post(`/api/v1/staff/schedule/activity-events/${evId}/start`)
      .set('Authorization', `Bearer ${staffToken}`)
      .expect(200);
    expect(startRes.body.status).toBe('in_progress');

    // Staff complete → completed
    const completeRes = await request(server)
      .post(`/api/v1/staff/schedule/activity-events/${evId}/complete`)
      .set('Authorization', `Bearer ${staffToken}`)
      .expect(200);
    expect(completeRes.body.status).toBe('completed');

    // Staff start AGAIN → 409 invalid_activity_event_transition
    const restartRes = await request(server)
      .post(`/api/v1/staff/schedule/activity-events/${evId}/start`)
      .set('Authorization', `Bearer ${staffToken}`);
    expect(restartRes.status).toBe(409);
    expect(restartRes.body.error).toBe('invalid_activity_event_transition');

    // Cancel from completed → 409 invalid_activity_event_transition
    const cancelRes = await request(server)
      .post(`/api/v1/staff/schedule/activity-events/${evId}/cancel`)
      .set('Authorization', `Bearer ${staffToken}`)
      .send({ reason: 'попытка отмены' });
    expect(cancelRes.status).toBe(409);
    expect(cancelRes.body.error).toBe('invalid_activity_event_transition');
  });

  // ── D. Parent: schedule via ChildAccessGuard ──────────────────────────

  it('returns 200 for approved parent and 403 for non-guardian parent (Scenario D)', async () => {
    const a = await createKgWithAdmin('sch-d', '+77011120104');
    const grpId = await createGroup(a.adminToken);

    // Create an event in the group so the schedule is non-empty
    await request(server)
      .post('/api/v1/admin/schedule/activity-events')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({
        groupId: grpId,
        activityName: 'Утро',
        startsAt: '2026-05-05T07:00:00.000Z',
        endsAt: '2026-05-05T07:30:00.000Z',
      })
      .expect(201);

    // Create child and assign to group
    const childId = await createChild(a.adminToken, {
      full_name: 'D-Child',
      date_of_birth: '2021-08-15',
    });
    await assignChildToGroup(childId, grpId);

    // Parent A is an approved guardian
    const userAId = await seedUser('+77011110201');
    await seedApprovedGuardian(childId, userAId, a.kgId);
    const parentAToken = await mintParentAccess({
      sub: userAId,
      kindergartenId: a.kgId,
    });

    // Parent A reads schedule → 200
    const schedRes = await request(server)
      .get(`/api/v1/parent/children/${childId}/schedule`)
      .set('Authorization', `Bearer ${parentAToken}`)
      .query({ dateFrom: '2026-05-05', dateTo: '2026-05-06' })
      .expect(200);
    expect(Array.isArray(schedRes.body)).toBe(true);

    // Parent B (different user, no guardian row) → 403
    const userBId = await seedUser('+77011110202');
    const parentBToken = await mintParentAccess({
      sub: userBId,
      kindergartenId: a.kgId,
    });
    const deniedRes = await request(server)
      .get(`/api/v1/parent/children/${childId}/schedule`)
      .set('Authorization', `Bearer ${parentBToken}`)
      .query({ dateFrom: '2026-05-05', dateTo: '2026-05-06' });
    expect(deniedRes.status).toBe(403);
  });

  // ── E. Manual copy-week (idempotent) ──────────────────────────────────

  it('copies week on first call and returns skipped on second call (Scenario E)', async () => {
    const a = await createKgWithAdmin('sch-e', '+77011120105');
    const grpId = await createGroup(a.adminToken);

    // Create a schedule template with a slot to give the copy job something to copy
    const tplRes = await request(server)
      .post('/api/v1/admin/schedule/templates')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({
        groupId: grpId,
        name: 'Шаблон для копирования',
        validFrom: '2026-04-27',
        isActive: true,
      })
      .expect(201);
    await request(server)
      .post(`/api/v1/admin/schedule/templates/${tplRes.body.id}/slots`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({
        dayOfWeek: 'mon',
        startTime: '09:00',
        endTime: '09:45',
        activityName: 'Кружок',
      })
      .expect(201);

    // First copy call → copiedGroups should be > 0 (at least 1 group was copied)
    const firstCopy = await request(server)
      .post('/api/v1/admin/schedule/week-snapshots/copy')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ fromMonday: '2026-04-27' })
      .expect(200);
    expect(firstCopy.body.copiedGroups).toBeGreaterThan(0);
    expect(typeof firstCopy.body.skippedGroups).toBe('number');
    expect(typeof firstCopy.body.totalEvents).toBe('number');

    // Second call same args → idempotent: skippedGroups > 0, copiedGroups = 0
    const secondCopy = await request(server)
      .post('/api/v1/admin/schedule/week-snapshots/copy')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ fromMonday: '2026-04-27' })
      .expect(200);
    expect(secondCopy.body.copiedGroups).toBe(0);
    expect(secondCopy.body.skippedGroups).toBeGreaterThan(0);
  });

  // ── F. Validation: invalid slot time ─────────────────────────────────

  it('rejects slot with start_time >= end_time with 400 (Scenario F)', async () => {
    const a = await createKgWithAdmin('sch-f', '+77011120106');
    const grpId = await createGroup(a.adminToken);

    const tplRes = await request(server)
      .post('/api/v1/admin/schedule/templates')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({
        groupId: grpId,
        name: 'Валидационный шаблон',
        validFrom: '2026-05-04',
      })
      .expect(201);

    // startTime === endTime → invalid_slot_time or validation error → 400 or 422
    const badSlot = await request(server)
      .post(`/api/v1/admin/schedule/templates/${tplRes.body.id}/slots`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({
        dayOfWeek: 'tue',
        startTime: '10:00',
        endTime: '10:00',
        activityName: 'Нулевой слот',
      });
    expect([400, 409, 422]).toContain(badSlot.status);

    // startTime after endTime
    const badSlot2 = await request(server)
      .post(`/api/v1/admin/schedule/templates/${tplRes.body.id}/slots`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({
        dayOfWeek: 'tue',
        startTime: '11:00',
        endTime: '10:00',
        activityName: 'Перевёрнутый слот',
      });
    expect([400, 409, 422]).toContain(badSlot2.status);
  });

  // ── G. Cross-tenant isolation ────────────────────────────────────────

  it('hides KG-A template from KG-B admin via RLS (Scenario G)', async () => {
    const a = await createKgWithAdmin('sch-g-a', '+77011120107');
    const b = await createKgWithAdmin('sch-g-b', '+77011120108');
    const grpId = await createGroup(a.adminToken);

    // Create template in kg_A
    const tplRes = await request(server)
      .post('/api/v1/admin/schedule/templates')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({
        groupId: grpId,
        name: 'KG-A only template',
        validFrom: '2026-05-04',
      })
      .expect(201);
    const tplId = tplRes.body.id as string;

    // KG-B admin tries to read it → 404 (RLS hides the row)
    const crossRes = await request(server)
      .get(`/api/v1/admin/schedule/templates/${tplId}`)
      .set('Authorization', `Bearer ${b.adminToken}`);
    expect(crossRes.status).toBe(404);
  });

  // ── H. Parent: child without group → empty schedule ──────────────────

  it('returns 200 with empty array for child without active group assignment (Scenario H)', async () => {
    const a = await createKgWithAdmin('sch-h', '+77011120109');

    // Child is NOT assigned to any group
    const childId = await createChild(a.adminToken, {
      full_name: 'H-Child',
      date_of_birth: '2021-09-15',
    });

    const userHId = await seedUser('+77011110209');
    await seedApprovedGuardian(childId, userHId, a.kgId);
    const parentHToken = await mintParentAccess({
      sub: userHId,
      kindergartenId: a.kgId,
    });

    const schedRes = await request(server)
      .get(`/api/v1/parent/children/${childId}/schedule`)
      .set('Authorization', `Bearer ${parentHToken}`)
      .query({ dateFrom: '2026-05-05', dateTo: '2026-05-12' })
      .expect(200);
    expect(Array.isArray(schedRes.body)).toBe(true);
    expect(schedRes.body).toHaveLength(0);
  });
});
