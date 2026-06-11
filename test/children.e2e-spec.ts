/**
 * P5 children & guardians e2e — exercises the admin surface (POST/GET/PATCH
 * children, group transfer + history, guardians invite/list/update/revoke)
 * and the parent-side ChildAccessGuard + state-machine flow (approve/reject/
 * revoke + permissions patch).
 *
 * Mints admin / parent JWTs directly the same way organization.e2e-spec
 * does — the role-select flow is not needed to exercise these handlers.
 */
import type { Server } from 'node:http';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createTestApp, flushRedis, TestApp, truncateAll } from './helpers/app';

const SUPER_ADMIN_EMAIL = 'super-children@shyraq.test';
const SUPER_ADMIN_PASSWORD = 'admin12345';

interface CreatedKgResp {
  kindergarten: { id: string; slug: string };
  staff_member: { id: string; user_id: string };
  user: { id: string; phone: string };
}

describe('P5 children & guardians (e2e)', () => {
  let ctx: TestApp;
  let server: Server;
  let saAccess: string;
  let jwtService: JwtService;
  let jwtSecret: string;

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

  /**
   * Mints a parent JWT with NO `kindergarten_id` claim — used to exercise the
   * F7 fix where ChildAccessGuard derives the tenant from the resolved
   * guardian row instead of the JWT (parent freshly linked but token not yet
   * rotated, or multi-kg parent state). KindergartenScopeGuard accepts this
   * shape (kgId left null on req.tenant).
   */
  async function mintParentAccessNoKg(sub: string): Promise<string> {
    return jwtService.signAsync(
      { sub, role: 'parent', jti: randomUUID() },
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
        name: 'Children-Test KG',
        slug,
        admin: { full_name: 'Admin', phone },
      })
      .expect(201);
    const body = res.body as CreatedKgResp;
    const adminToken = await mintAdminAccess({
      sub: body.user.id,
      kindergartenId: body.kindergarten.id,
    });
    return { kgId: body.kindergarten.id, userId: body.user.id, adminToken };
  }

  /**
   * Manually seeds an APPROVED PRIMARY guardian for a child via direct SQL
   * with bypass_rls. Mirrors how the legacy onboarding flow leaves the
   * primary in place before any parent endpoint can be exercised.
   */
  async function seedPrimaryGuardian(opts: {
    kgId: string;
    childId: string;
    userId: string;
  }): Promise<string> {
    const guardianId = randomUUID();
    await ctx.dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      await m.query(
        `INSERT INTO child_guardians
           (id, kindergarten_id, child_id, user_id, role, status, has_approval_rights, can_pickup, permissions, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'primary', 'approved', false, true, '{}'::jsonb, now(), now())`,
        [guardianId, opts.kgId, opts.childId, opts.userId],
      );
    });
    return guardianId;
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

  // ── admin: children CRUD ────────────────────────────────────────────────

  it('POST /children creates a card with status=card_created', async () => {
    const a = await createKgWithAdmin('children-1', '+77011115001');
    const res = await request(server)
      .post('/api/v1/children')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({
        full_name: 'Aigerim Nursultankyzy',
        date_of_birth: '2021-09-15',
        gender: 'female',
        allergy_notes: 'Peanut allergy',
      })
      .expect(201);
    expect(res.body.status).toBe('card_created');
    expect(res.body.full_name).toBe('Aigerim Nursultankyzy');
    expect(res.body.gender).toBe('female');
  });

  it('POST /children rejects duplicate IIN within the same kg', async () => {
    const a = await createKgWithAdmin('children-2', '+77011115002');
    await request(server)
      .post('/api/v1/children')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({
        full_name: 'Aigerim',
        date_of_birth: '2021-09-15',
        iin: '040315500123',
      })
      .expect(201);
    await request(server)
      .post('/api/v1/children')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({
        full_name: 'Bota',
        date_of_birth: '2021-09-15',
        iin: '040315500123',
      })
      .expect(409);
  });

  it('GET /children paginates and filters by status', async () => {
    const a = await createKgWithAdmin('children-3', '+77011115003');
    for (let i = 0; i < 3; i++) {
      await request(server)
        .post('/api/v1/children')
        .set('Authorization', `Bearer ${a.adminToken}`)
        .send({
          full_name: `Child ${i}`,
          date_of_birth: '2021-09-15',
        })
        .expect(201);
    }
    const res = await request(server)
      .get('/api/v1/children?limit=2&offset=0&status=card_created')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .expect(200);
    expect(res.body.data.length).toBe(2);
    expect(res.body.meta.total).toBe(3);
  });

  it('PATCH /children/:id updates profile, archive→409-on-replay→reactivate flow; legacy /restore is gone', async () => {
    const a = await createKgWithAdmin('children-4', '+77011115004');
    const created = await request(server)
      .post('/api/v1/children')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ full_name: 'A', date_of_birth: '2021-09-15' })
      .expect(201);
    const id = created.body.id as string;
    // B21 T2 strict state machine: archive only accepts `status='active'`.
    // Newly-created children start `card_created`; enrollment flow that
    // activates them is exercised by other suites. Seed `status='active'`
    // via direct SQL (matches the lifecycle e2e helper pattern).
    await ctx.dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      await m.query(`UPDATE children SET status = 'active' WHERE id = $1`, [
        id,
      ]);
    });
    await request(server)
      .patch(`/api/v1/children/${id}`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ full_name: 'B' })
      .expect(200)
      .expect((r) => expect(r.body.full_name).toBe('B'));
    // B21 T2/T4: archive_reason is now the required field name; double
    // archive is no longer idempotent and surfaces 409.
    await request(server)
      .post(`/api/v1/children/${id}/archive`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ archive_reason: 'gone' })
      .expect(200)
      .expect((r) => expect(r.body.status).toBe('archived'));
    await request(server)
      .post(`/api/v1/children/${id}/archive`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ archive_reason: 'second attempt' })
      .expect(409)
      .expect((r) => expect(r.body.error).toBe('child_already_archived'));
    // B22b T12: the legacy /restore route has been fully removed (the B22a
    // T11 410-Gone shim shipped for one release). Hitting the legacy path
    // now falls through to the router-level 404 — clients must use
    // /reactivate.
    await request(server)
      .post(`/api/v1/children/${id}/restore`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .expect(404);
    // /reactivate (the documented successor) still works.
    await request(server)
      .post(`/api/v1/children/${id}/reactivate`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({})
      .expect(200)
      .expect((r) => expect(r.body.child.status).toBe('active'));
  });

  it('POST /children/:id/transfer logs a child_group_history row', async () => {
    const a = await createKgWithAdmin('children-5', '+77011115005');
    const child = await request(server)
      .post('/api/v1/children')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ full_name: 'A', date_of_birth: '2021-09-15' })
      .expect(201);
    const grp = await request(server)
      .post('/api/v1/groups')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ name: 'Bears', capacity: 15 })
      .expect(201);
    const out = await request(server)
      .post(`/api/v1/children/${child.body.id}/transfer`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ to_group_id: grp.body.id, reason: 'promotion' })
      .expect(200);
    expect(out.body.current_group_id).toBe(grp.body.id);
    // Identity overlay: the child card carries the resolved group name.
    expect(out.body.current_group_name).toBe('Bears');
    const history = await request(server)
      .get(`/api/v1/children/${child.body.id}/group-history`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .expect(200);
    expect(history.body.length).toBe(1);
    expect(history.body[0].to_group_id).toBe(grp.body.id);
    expect(history.body[0].reason).toBe('promotion');
  });

  // ── admin: guardians ────────────────────────────────────────────────────

  it('POST /children/:id/guardians invites by phone (find-or-create user)', async () => {
    const a = await createKgWithAdmin('children-6', '+77011115006');
    const child = await request(server)
      .post('/api/v1/children')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ full_name: 'A', date_of_birth: '2021-09-15' })
      .expect(201);
    const res = await request(server)
      .post(`/api/v1/children/${child.body.id}/guardians`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({
        user_phone: '+77011119999',
        role: 'secondary',
        can_pickup: true,
      })
      .expect(201);
    expect(res.body.status).toBe('pending_approval');
    expect(res.body.role).toBe('secondary');
    // GuardianDto carries display fields resolved from the linked users row.
    // find-or-create seeds users.full_name = phone for a brand-new user, so
    // both surface the phone here; user_phone is always the E.164 number.
    expect(res.body).toHaveProperty('user_full_name');
    expect(res.body).toHaveProperty('user_phone');
    expect(res.body.user_phone).toBe('+77011119999');
  });

  it('POST /children/:id/guardians rejects when both user_phone and user_id are missing', async () => {
    const a = await createKgWithAdmin('children-7', '+77011115007');
    const child = await request(server)
      .post('/api/v1/children')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ full_name: 'A', date_of_birth: '2021-09-15' })
      .expect(201);
    await request(server)
      .post(`/api/v1/children/${child.body.id}/guardians`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ role: 'secondary' })
      .expect(400);
  });

  it('full guardian state-machine — invite, primary approves, primary revokes', async () => {
    const a = await createKgWithAdmin('children-8', '+77011115008');
    const child = await request(server)
      .post('/api/v1/children')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ full_name: 'A', date_of_birth: '2021-09-15' })
      .expect(201);
    // Seed an approved primary that we will impersonate.
    const primaryUserId = await seedUser('+77011110001');
    await seedPrimaryGuardian({
      kgId: a.kgId,
      childId: child.body.id,
      userId: primaryUserId,
    });
    const primaryToken = await mintParentAccess({
      sub: primaryUserId,
      kindergartenId: a.kgId,
    });
    // Admin invites a new guardian.
    const invite = await request(server)
      .post(`/api/v1/children/${child.body.id}/guardians`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ user_phone: '+77011110002', role: 'secondary' })
      .expect(201);
    const newGuardianId = invite.body.id as string;
    // Primary lists pending approvals.
    const pending = await request(server)
      .get('/api/v1/parent/approvals/pending')
      .set('Authorization', `Bearer ${primaryToken}`)
      .expect(200);
    expect(pending.body.length).toBe(1);
    expect(pending.body[0].id).toBe(newGuardianId);
    // Primary approves.
    const approved = await request(server)
      .post(`/api/v1/parent/approvals/${newGuardianId}/approve`)
      .set('Authorization', `Bearer ${primaryToken}`)
      .send({ grant_approval_rights: false })
      .expect(200);
    expect(approved.body.status).toBe('approved');
    // Primary revokes.
    const revoked = await request(server)
      .post(`/api/v1/parent/approvals/${newGuardianId}/revoke`)
      .set('Authorization', `Bearer ${primaryToken}`)
      .expect(200);
    expect(revoked.body.status).toBe('revoked');
  });

  it('parent without approved guardian is forbidden by ChildAccessGuard', async () => {
    const a = await createKgWithAdmin('children-9', '+77011115009');
    const child = await request(server)
      .post('/api/v1/children')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ full_name: 'A', date_of_birth: '2021-09-15' })
      .expect(201);
    // Stranger parent — no guardian record at all.
    const strangerId = await seedUser('+77019998888');
    const strangerToken = await mintParentAccess({
      sub: strangerId,
      kindergartenId: a.kgId,
    });
    await request(server)
      .get(`/api/v1/parent/children/${child.body.id}`)
      .set('Authorization', `Bearer ${strangerToken}`)
      .expect(403);
  });

  it('GET /parent/children returns only children where the user is approved guardian', async () => {
    const a = await createKgWithAdmin('children-10', '+77011115010');
    const c1 = await request(server)
      .post('/api/v1/children')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ full_name: 'A', date_of_birth: '2021-09-15' })
      .expect(201);
    await request(server)
      .post('/api/v1/children')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ full_name: 'B', date_of_birth: '2021-09-15' })
      .expect(201);
    // Assign c1 to a group so the kg-scoped parent listing carries the
    // resolved current_group_name overlay.
    const grp = await request(server)
      .post('/api/v1/groups')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ name: 'Sunflowers', capacity: 15 })
      .expect(201);
    await request(server)
      .post(`/api/v1/children/${c1.body.id}/group`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ group_id: grp.body.id })
      .expect(200);
    const parentId = await seedUser('+77011110011');
    await seedPrimaryGuardian({
      kgId: a.kgId,
      childId: c1.body.id,
      userId: parentId,
    });
    const parentToken = await mintParentAccess({
      sub: parentId,
      kindergartenId: a.kgId,
    });
    const res = await request(server)
      .get('/api/v1/parent/children')
      .set('Authorization', `Bearer ${parentToken}`)
      .expect(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].id).toBe(c1.body.id);
    expect(res.body[0].current_group_name).toBe('Sunflowers');
  });

  it('GET /parent/children/:id returns 200 even when JWT carries no kindergarten_id (F7)', async () => {
    // F7 regression — ChildAccessGuard pins req.tenant from the resolved
    // approved-guardian row, so a parent whose JWT was issued without a
    // kg-claim (multi-kg user, or freshly-linked-but-not-yet-rotated token)
    // can still load /parent/children/:id without `tenant_required`.
    const a = await createKgWithAdmin('children-f7-id', '+77011115077');
    const child = await request(server)
      .post('/api/v1/children')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ full_name: 'F7-child', date_of_birth: '2021-09-15' })
      .expect(201);
    const parentId = await seedUser('+77011110071');
    await seedPrimaryGuardian({
      kgId: a.kgId,
      childId: child.body.id,
      userId: parentId,
    });
    const tokenNoKg = await mintParentAccessNoKg(parentId);
    const res = await request(server)
      .get(`/api/v1/parent/children/${child.body.id}`)
      .set('Authorization', `Bearer ${tokenNoKg}`)
      .expect(200);
    expect(res.body.child.id).toBe(child.body.id);
    expect(res.body.guardians).toBeDefined();
    // N2 fix — guardians carry display fields resolved from `users`, not a
    // bare UUID. The seeded user has an empty full_name → null fallback; the
    // phone is always resolved.
    const seededGuardian = res.body.guardians.find(
      (g: { user_id: string }) => g.user_id === parentId,
    );
    expect(seededGuardian).toBeDefined();
    expect(seededGuardian.user_full_name).toBeNull();
    expect(seededGuardian.user_phone).toBe('+77011110071');

    // Stranger child id under same JWT → 403, not 400 — the guard's
    // unhappy-path still rejects with `child_access_denied`.
    const stranger = await request(server)
      .post('/api/v1/children')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ full_name: 'unrelated', date_of_birth: '2021-09-15' })
      .expect(201);
    await request(server)
      .get(`/api/v1/parent/children/${stranger.body.id}`)
      .set('Authorization', `Bearer ${tokenNoKg}`)
      .expect(403);
  });

  it('GET /parent/children fans out cross-tenant when JWT has no kindergarten_id (F7)', async () => {
    // Same parent approved as primary in two kgs. The unscoped JWT path
    // routes to listMyChildrenCrossTenant which returns both children.
    const a = await createKgWithAdmin('children-f7-list-a', '+77011115078');
    const b = await createKgWithAdmin('children-f7-list-b', '+77011115079');
    const c1 = await request(server)
      .post('/api/v1/children')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ full_name: 'F7-A', date_of_birth: '2021-09-15' })
      .expect(201);
    const c2 = await request(server)
      .post('/api/v1/children')
      .set('Authorization', `Bearer ${b.adminToken}`)
      .send({ full_name: 'F7-B', date_of_birth: '2021-09-15' })
      .expect(201);
    const parentId = await seedUser('+77011110072');
    await seedPrimaryGuardian({
      kgId: a.kgId,
      childId: c1.body.id,
      userId: parentId,
    });
    await seedPrimaryGuardian({
      kgId: b.kgId,
      childId: c2.body.id,
      userId: parentId,
    });
    const tokenNoKg = await mintParentAccessNoKg(parentId);
    const res = await request(server)
      .get('/api/v1/parent/children')
      .set('Authorization', `Bearer ${tokenNoKg}`)
      .expect(200);
    const ids = (res.body as Array<{ id: string }>).map((c) => c.id).sort();
    expect(ids).toEqual([c1.body.id, c2.body.id].sort());
  });

  it('PATCH /parent/approvals/:id/permissions persists overrides and rejects locked keys', async () => {
    const a = await createKgWithAdmin('children-11', '+77011115011');
    const child = await request(server)
      .post('/api/v1/children')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ full_name: 'A', date_of_birth: '2021-09-15' })
      .expect(201);
    const primaryUserId = await seedUser('+77011110021');
    await seedPrimaryGuardian({
      kgId: a.kgId,
      childId: child.body.id,
      userId: primaryUserId,
    });
    const primaryToken = await mintParentAccess({
      sub: primaryUserId,
      kindergartenId: a.kgId,
    });
    const invited = await request(server)
      .post(`/api/v1/children/${child.body.id}/guardians`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .send({ user_phone: '+77011110031', role: 'secondary' })
      .expect(201);
    await request(server)
      .post(`/api/v1/parent/approvals/${invited.body.id}/approve`)
      .set('Authorization', `Bearer ${primaryToken}`)
      .send({ grant_approval_rights: false })
      .expect(200);
    // Apply a permissions override.
    const out = await request(server)
      .patch(`/api/v1/parent/approvals/${invited.body.id}/permissions`)
      .set('Authorization', `Bearer ${primaryToken}`)
      .send({ permissions: { view_cctv: false } })
      .expect(200);
    expect(out.body.effective.view_cctv).toBe(false);
    expect(out.body.effective.view_timeline).toBe(true);
    // Locked keys (prepayment) are rejected.
    await request(server)
      .patch(`/api/v1/parent/approvals/${invited.body.id}/permissions`)
      .set('Authorization', `Bearer ${primaryToken}`)
      .send({ permissions: { prepayment: false } })
      .expect(422);
  });
});
