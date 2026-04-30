/**
 * B7 weekly rollout e2e — exercises the super-admin manual trigger
 * `POST /api/v1/admin/schedule/week-rollout/run` that combines schedule
 * auto-copy + meal plan copy across all active kindergartens.
 *
 * Endpoint under test:
 *   POST /api/v1/admin/schedule/week-rollout/run
 *     - @Roles('super_admin') + @SuperAdminScope()
 *     - Returns RolloutSummaryResponseDto
 *     - Idempotent: re-runs with same fromMonday → all counters in
 *       skippedGroups / plansSkipped
 *
 * Scenarios:
 *   I.  Super-admin triggers rollout with seeded kg+group+template+meal →
 *       200, totals.copiedGroups > 0 on first call, 0 on re-run.
 *   II. Non-super-admin (admin role) → 403.
 */
import type { Server } from 'node:http';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createTestApp, flushRedis, TestApp, truncateAll } from './helpers/app';

const SUPER_ADMIN_EMAIL = 'super-rollout@shyraq.test';
const SUPER_ADMIN_PASSWORD = 'admin12345';

interface CreatedKgResp {
  kindergarten: { id: string; slug: string };
  staff_member: { id: string; user_id: string };
  user: { id: string; phone: string };
}

describe('B7 weekly rollout (e2e)', () => {
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
    adminToken: string;
  }> {
    const res = await request(server)
      .post('/api/v1/saas/kindergartens')
      .set('Authorization', `Bearer ${saAccess}`)
      .send({
        name: 'Rollout-Test KG',
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
      adminToken,
    };
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

  // ── I. Super-admin manual rollout trigger ─────────────────────────────────

  it('returns 200 with copiedGroups > 0 on first run and 0 on re-run (Scenario I)', async () => {
    const a = await createKgWithAdmin('rollout-i', '+77011120301');

    // Create a group
    const grpRes = await request(server)
      .post('/api/v1/groups')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ name: 'Тест группа', capacity: 20 })
      .expect(201);
    const grpId = grpRes.body.id as string;

    // Create an active schedule template with a slot
    const tplRes = await request(server)
      .post('/api/v1/admin/schedule/templates')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({
        groupId: grpId,
        name: 'Rollout Template',
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
        activityName: 'Утренний круг',
      })
      .expect(201);

    // Create a source-week meal plan
    await request(server)
      .post('/api/v1/admin/meal-plans')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({
        date: '2026-04-27',
        group_id: grpId,
        is_published: true,
      })
      .expect(201);

    // Super-admin triggers rollout — first run
    const firstRun = await request(server)
      .post('/api/v1/admin/schedule/week-rollout/run')
      .set('Authorization', `Bearer ${saAccess}`)
      .send({ fromMonday: '2026-04-27' })
      .expect(200);

    expect(firstRun.body.fromMonday).toBeDefined();
    expect(firstRun.body.source).toBe('manual');
    expect(Array.isArray(firstRun.body.kindergartens)).toBe(true);
    expect(firstRun.body.totals).toBeDefined();
    // At least one group was copied across all kgs
    expect(firstRun.body.totals.copiedGroups).toBeGreaterThan(0);

    // Re-run with same fromMonday → idempotent
    const secondRun = await request(server)
      .post('/api/v1/admin/schedule/week-rollout/run')
      .set('Authorization', `Bearer ${saAccess}`)
      .send({ fromMonday: '2026-04-27' })
      .expect(200);

    expect(secondRun.body.totals.copiedGroups).toBe(0);
    expect(secondRun.body.totals.skippedGroups).toBeGreaterThan(0);
  });

  // ── II. Admin (non-super) is rejected ─────────────────────────────────────

  it('rejects admin-role token on POST /admin/schedule/week-rollout/run with 403 (Scenario II)', async () => {
    const a = await createKgWithAdmin('rollout-ii', '+77011120302');

    const deniedRes = await request(server)
      .post('/api/v1/admin/schedule/week-rollout/run')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ fromMonday: '2026-04-27' });
    expect(deniedRes.status).toBe(403);
  });
});
