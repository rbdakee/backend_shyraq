/**
 * P4 organization e2e — exercises the four admin-scoped resource surfaces in
 * a single suite (staff, locations, groups, cameras) plus mentor-assignment
 * lifecycle. Mints admin JWTs directly the same way kindergarten.e2e-spec
 * does — the role-select flow is not needed to exercise these handlers.
 *
 * Cross-tenant isolation is asserted at the bottom: KG-A's admin gets 404 on
 * KG-B's group/staff/etc., proving RLS + explicit kg-scoping in the service.
 */
import type { Server } from 'node:http';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createTestApp, flushRedis, TestApp, truncateAll } from './helpers/app';

const SUPER_ADMIN_EMAIL = 'super-org@shyraq.test';
const SUPER_ADMIN_PASSWORD = 'admin12345';

interface CreatedKgResp {
  kindergarten: { id: string; slug: string };
  staff_member: { id: string; user_id: string };
  user: { id: string; phone: string };
}

describe('P4 organization endpoints (e2e)', () => {
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
        name: 'Org-Test KG',
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

  // ── staff ───────────────────────────────────────────────────────────────

  describe('staff CRUD', () => {
    it('POST /staff creates a staff member', async () => {
      const a = await createKgWithAdmin('org-staff-1', '+77011114001');
      const res = await request(server)
        .post('/api/v1/staff')
        .set('Authorization', `Bearer ${a.adminToken}`)
        .send({
          full_name: 'Jane Mentor',
          phone: '+77011114011',
          role: 'mentor',
        })
        .expect(201);
      expect(res.body.role).toBe('mentor');
      expect(res.body.full_name).toBe('Jane Mentor');
    });

    it('GET /staff includes the seeded admin', async () => {
      const a = await createKgWithAdmin('org-staff-2', '+77011114002');
      const res = await request(server)
        .get('/api/v1/staff')
        .set('Authorization', `Bearer ${a.adminToken}`)
        .expect(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
    });

    it('PATCH /staff/:id renames', async () => {
      const a = await createKgWithAdmin('org-staff-3', '+77011114003');
      const create = await request(server)
        .post('/api/v1/staff')
        .set('Authorization', `Bearer ${a.adminToken}`)
        .send({
          full_name: 'Bob Reception',
          phone: '+77011114013',
          role: 'reception',
        })
        .expect(201);
      const id = create.body.id as string;
      const res = await request(server)
        .patch(`/api/v1/staff/${id}`)
        .set('Authorization', `Bearer ${a.adminToken}`)
        .send({ full_name: 'Robert' })
        .expect(200);
      expect(res.body.full_name).toBe('Robert');
    });

    it('archive + restore is idempotent', async () => {
      const a = await createKgWithAdmin('org-staff-4', '+77011114004');
      const create = await request(server)
        .post('/api/v1/staff')
        .set('Authorization', `Bearer ${a.adminToken}`)
        .send({
          full_name: 'X',
          phone: '+77011114014',
          role: 'mentor',
        })
        .expect(201);
      const id = create.body.id as string;
      await request(server)
        .post(`/api/v1/staff/${id}/archive`)
        .set('Authorization', `Bearer ${a.adminToken}`)
        .expect(200);
      await request(server)
        .post(`/api/v1/staff/${id}/archive`)
        .set('Authorization', `Bearer ${a.adminToken}`)
        .expect(200);
      const restored = await request(server)
        .post(`/api/v1/staff/${id}/restore`)
        .set('Authorization', `Bearer ${a.adminToken}`)
        .expect(200);
      expect(restored.body.archived_at).toBeNull();
    });
  });

  // ── locations ──────────────────────────────────────────────────────────

  describe('locations CRUD', () => {
    it('POST + GET + PATCH', async () => {
      const a = await createKgWithAdmin('org-loc-1', '+77011114101');
      const create = await request(server)
        .post('/api/v1/locations')
        .set('Authorization', `Bearer ${a.adminToken}`)
        .send({ name: 'Garden Hall', description: 'main hall' })
        .expect(201);
      const id = create.body.id as string;

      const get = await request(server)
        .get(`/api/v1/locations/${id}`)
        .set('Authorization', `Bearer ${a.adminToken}`)
        .expect(200);
      expect(get.body.name).toBe('Garden Hall');

      const upd = await request(server)
        .patch(`/api/v1/locations/${id}`)
        .set('Authorization', `Bearer ${a.adminToken}`)
        .send({ description: null })
        .expect(200);
      expect(upd.body.description).toBeNull();
    });
  });

  // ── groups + mentor lifecycle ──────────────────────────────────────────

  describe('groups + mentor', () => {
    it('full create → assign mentor → reassign → unassign flow', async () => {
      const a = await createKgWithAdmin('org-grp-1', '+77011114201');

      const grp = await request(server)
        .post('/api/v1/groups')
        .set('Authorization', `Bearer ${a.adminToken}`)
        .send({
          name: 'Bears',
          capacity: 15,
          age_range_min: 2,
          age_range_max: 4,
        })
        .expect(201);
      const groupId = grp.body.id as string;
      expect(grp.body.capacity).toBe(15);

      // Need at least two staff members to test reassignment.
      const s1 = await request(server)
        .post('/api/v1/staff')
        .set('Authorization', `Bearer ${a.adminToken}`)
        .send({
          full_name: 'Mentor One',
          phone: '+77011114211',
          role: 'mentor',
        })
        .expect(201);
      const s2 = await request(server)
        .post('/api/v1/staff')
        .set('Authorization', `Bearer ${a.adminToken}`)
        .send({
          full_name: 'Mentor Two',
          phone: '+77011114212',
          role: 'mentor',
        })
        .expect(201);
      const staff1 = s1.body.id as string;
      const staff2 = s2.body.id as string;

      // First assignment.
      const m1 = await request(server)
        .post(`/api/v1/groups/${groupId}/mentor`)
        .set('Authorization', `Bearer ${a.adminToken}`)
        .send({ staff_member_id: staff1 })
        .expect(200);
      expect(m1.body.staff_member_id).toBe(staff1);
      expect(m1.body.unassigned_at).toBeNull();

      // Reassign — must close the previous active row and create a new one.
      const m2 = await request(server)
        .post(`/api/v1/groups/${groupId}/mentor`)
        .set('Authorization', `Bearer ${a.adminToken}`)
        .send({ staff_member_id: staff2 })
        .expect(200);
      expect(m2.body.staff_member_id).toBe(staff2);
      expect(m2.body.unassigned_at).toBeNull();

      // Active mentor is staff2.
      const active = await request(server)
        .get(`/api/v1/groups/${groupId}/mentor`)
        .set('Authorization', `Bearer ${a.adminToken}`)
        .expect(200);
      expect(active.body.staff_member_id).toBe(staff2);

      // History contains both rows.
      const hist = await request(server)
        .get(`/api/v1/groups/${groupId}/mentor-history`)
        .set('Authorization', `Bearer ${a.adminToken}`)
        .expect(200);
      expect(hist.body).toHaveLength(2);

      // Unassign — idempotent on the second call.
      await request(server)
        .delete(`/api/v1/groups/${groupId}/mentor`)
        .set('Authorization', `Bearer ${a.adminToken}`)
        .expect(204);
      await request(server)
        .delete(`/api/v1/groups/${groupId}/mentor`)
        .set('Authorization', `Bearer ${a.adminToken}`)
        .expect(204);

      const empty = await request(server)
        .get(`/api/v1/groups/${groupId}/mentor`)
        .set('Authorization', `Bearer ${a.adminToken}`)
        .expect(200);
      // supertest serializes JSON null as an empty body; assert via text.
      expect(empty.text === '' || empty.text === 'null').toBe(true);
    });

    it('rejects non-positive capacity', async () => {
      const a = await createKgWithAdmin('org-grp-2', '+77011114202');
      const res = await request(server)
        .post('/api/v1/groups')
        .set('Authorization', `Bearer ${a.adminToken}`)
        .send({ name: 'X', capacity: 0 });
      // ValidationPipe surfaces 422 in this app (see utils/validation-options).
      expect([400, 422]).toContain(res.status);
    });
  });

  // ── cameras ────────────────────────────────────────────────────────────

  describe('cameras', () => {
    it('create camera anchored to a location, then re-link', async () => {
      const a = await createKgWithAdmin('org-cam-1', '+77011114301');
      const loc1 = (
        await request(server)
          .post('/api/v1/locations')
          .set('Authorization', `Bearer ${a.adminToken}`)
          .send({ name: 'Loc A' })
          .expect(201)
      ).body.id as string;
      const loc2 = (
        await request(server)
          .post('/api/v1/locations')
          .set('Authorization', `Bearer ${a.adminToken}`)
          .send({ name: 'Loc B' })
          .expect(201)
      ).body.id as string;

      const cam = await request(server)
        .post('/api/v1/cameras')
        .set('Authorization', `Bearer ${a.adminToken}`)
        .send({
          location_id: loc1,
          name: 'Front Door',
          rtsp_url: 'rtsp://cam.local/stream',
        })
        .expect(201);
      const camId = cam.body.id as string;
      expect(cam.body.location_id).toBe(loc1);

      const linked = await request(server)
        .post(`/api/v1/cameras/${camId}/link-location`)
        .set('Authorization', `Bearer ${a.adminToken}`)
        .send({ location_id: loc2 })
        .expect(200);
      expect(linked.body.location_id).toBe(loc2);
    });
  });

  // ── cross-tenant isolation ─────────────────────────────────────────────

  describe('cross-tenant isolation', () => {
    it('admin of KG-A sees 404 on KG-B group via the group endpoint', async () => {
      const a = await createKgWithAdmin('iso-org-a', '+77011114401');
      const b = await createKgWithAdmin('iso-org-b', '+77011114402');

      const grpInB = await request(server)
        .post('/api/v1/groups')
        .set('Authorization', `Bearer ${b.adminToken}`)
        .send({ name: 'B-only', capacity: 5 })
        .expect(201);
      const groupId = grpInB.body.id as string;

      const cross = await request(server)
        .get(`/api/v1/groups/${groupId}`)
        .set('Authorization', `Bearer ${a.adminToken}`);
      expect(cross.status).toBe(404);

      // List under A returns the empty array (only A's seed-created
      // implicit groups, which is none — staff is seeded, groups are not).
      const listA = await request(server)
        .get('/api/v1/groups')
        .set('Authorization', `Bearer ${a.adminToken}`)
        .expect(200);
      const ids = (listA.body as Array<{ id: string }>).map((g) => g.id);
      expect(ids).not.toContain(groupId);
    });

    it('admin of KG-A sees 404 on KG-B location', async () => {
      const a = await createKgWithAdmin('iso-org-c', '+77011114403');
      const b = await createKgWithAdmin('iso-org-d', '+77011114404');

      const locB = await request(server)
        .post('/api/v1/locations')
        .set('Authorization', `Bearer ${b.adminToken}`)
        .send({ name: 'B-loc' })
        .expect(201);
      const cross = await request(server)
        .get(`/api/v1/locations/${locB.body.id}`)
        .set('Authorization', `Bearer ${a.adminToken}`);
      expect(cross.status).toBe(404);
    });
  });
});
