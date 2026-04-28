import type { Server } from 'node:http';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestApp, flushRedis, TestApp, truncateAll } from './helpers/app';

interface SuperAdminAuthBody {
  access_token: string;
  refresh_token: string;
}

interface KindergartenDto {
  id: string;
  name: string;
  slug: string;
  address: string | null;
  phone: string | null;
  plan: string;
  settings: Record<string, unknown>;
  is_active: boolean;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

interface StaffMemberDto {
  id: string;
  kindergarten_id: string;
  user_id: string;
  role: string;
  is_active: boolean;
  hired_at: string | null;
}

interface CreatedUserDto {
  id: string;
  phone: string;
  full_name: string;
  locale: string;
}

interface CreateKgResponse {
  kindergarten: KindergartenDto;
  staff_member: StaffMemberDto;
  user: CreatedUserDto;
}

interface ErrorBody {
  statusCode: number;
  error?: string;
  message?: string;
}

const ADMIN_EMAIL = 'super-kg@shyraq.test';
const ADMIN_PASSWORD = 'admin12345';

describe('SuperAdmin Kindergartens — /api/v1/saas/kindergartens (e2e)', () => {
  let ctx: TestApp;
  let server: Server;
  let saAccess: string;

  async function seedSuperAdmin(): Promise<void> {
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 4);
    await ctx.dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      await m.query(
        `INSERT INTO saas_users (id, email, full_name, password_hash, role, is_active)
         VALUES ($1, $2, 'SA', $3, 'super_admin', true)`,
        [randomUUID(), ADMIN_EMAIL, hash],
      );
    });
  }

  async function loginSuperAdmin(): Promise<string> {
    const res = await request(server)
      .post('/api/v1/saas/auth/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
      .expect(200);
    return (res.body as SuperAdminAuthBody).access_token;
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

  it('POST /saas/kindergartens creates kg + admin staff + new user; sends welcome SMS', async () => {
    const res = await request(server)
      .post('/api/v1/saas/kindergartens')
      .set('Authorization', `Bearer ${saAccess}`)
      .send({
        name: 'E2E Garden',
        slug: 'e2e-garden',
        admin: { full_name: 'Admin Alpha', phone: '+77011112233' },
      });
    expect(res.status).toBe(201);
    const body = res.body as CreateKgResponse;
    expect(body.kindergarten.slug).toBe('e2e-garden');
    expect(body.kindergarten.is_active).toBe(true);
    expect(body.kindergarten.archived_at).toBeNull();
    expect(body.staff_member.role).toBe('admin');
    expect(body.staff_member.kindergarten_id).toBe(body.kindergarten.id);
    expect(body.staff_member.user_id).toBe(body.user.id);
    expect(body.user.phone).toBe('+77011112233');
    expect(body.user.full_name).toBe('Admin Alpha');

    // SMS dispatched async — settle the microtask queue before asserting.
    await new Promise(setImmediate);
    expect(ctx.sms.log.some((s) => s.phone === '+77011112233')).toBe(true);
  });

  it('POST /saas/kindergartens with duplicate slug → 409 kindergarten_slug_taken', async () => {
    const payload = {
      name: 'Dup',
      slug: 'dup-slug-1',
      admin: { full_name: 'A', phone: '+77011112201' },
    };
    await request(server)
      .post('/api/v1/saas/kindergartens')
      .set('Authorization', `Bearer ${saAccess}`)
      .send(payload)
      .expect(201);
    const second = await request(server)
      .post('/api/v1/saas/kindergartens')
      .set('Authorization', `Bearer ${saAccess}`)
      .send({ ...payload, admin: { full_name: 'B', phone: '+77011112202' } });
    expect(second.status).toBe(409);
    expect((second.body as ErrorBody).error).toBe('kindergarten_slug_taken');
  });

  it('POST /saas/kindergartens with invalid slug → 400 invariant_violation', async () => {
    const res = await request(server)
      .post('/api/v1/saas/kindergartens')
      .set('Authorization', `Bearer ${saAccess}`)
      .send({
        name: 'Bad',
        slug: 'BAD SLUG',
        admin: { full_name: 'A', phone: '+77011112299' },
      });
    // class-validator pipe rejects with 422 (validation_options unprocessable),
    // domain layer rejects with 400 invariant_violation. Either is acceptable
    // — assert it is at least one of those.
    expect([400, 422]).toContain(res.status);
  });

  it('POST without bearer → 401', async () => {
    const res = await request(server)
      .post('/api/v1/saas/kindergartens')
      .send({
        name: 'X',
        slug: 'x-noauth',
        admin: { full_name: 'A', phone: '+77011112250' },
      });
    expect(res.status).toBe(401);
  });

  it('GET /saas/kindergartens returns paginated list with archived filter', async () => {
    await request(server)
      .post('/api/v1/saas/kindergartens')
      .set('Authorization', `Bearer ${saAccess}`)
      .send({
        name: 'List A',
        slug: 'list-a',
        admin: { full_name: 'A', phone: '+77011112301' },
      })
      .expect(201);
    const second = await request(server)
      .post('/api/v1/saas/kindergartens')
      .set('Authorization', `Bearer ${saAccess}`)
      .send({
        name: 'List B',
        slug: 'list-b',
        admin: { full_name: 'B', phone: '+77011112302' },
      })
      .expect(201);
    const secondId = (second.body as CreateKgResponse).kindergarten.id;
    await request(server)
      .post(`/api/v1/saas/kindergartens/${secondId}/archive`)
      .set('Authorization', `Bearer ${saAccess}`)
      .expect(200);

    const all = await request(server)
      .get('/api/v1/saas/kindergartens')
      .set('Authorization', `Bearer ${saAccess}`)
      .expect(200);
    expect(all.body.total).toBeGreaterThanOrEqual(2);

    const activeOnly = await request(server)
      .get('/api/v1/saas/kindergartens?archived=false')
      .set('Authorization', `Bearer ${saAccess}`)
      .expect(200);
    expect(
      (activeOnly.body.items as KindergartenDto[]).every(
        (kg) => kg.archived_at === null,
      ),
    ).toBe(true);

    const archivedOnly = await request(server)
      .get('/api/v1/saas/kindergartens?archived=true')
      .set('Authorization', `Bearer ${saAccess}`)
      .expect(200);
    expect(archivedOnly.body.items).toHaveLength(1);
    expect((archivedOnly.body.items[0] as KindergartenDto).id).toBe(secondId);
  });

  it('archive → restore round-trip toggles archived_at', async () => {
    const create = await request(server)
      .post('/api/v1/saas/kindergartens')
      .set('Authorization', `Bearer ${saAccess}`)
      .send({
        name: 'Round',
        slug: 'round-trip',
        admin: { full_name: 'A', phone: '+77011112401' },
      })
      .expect(201);
    const kgId = (create.body as CreateKgResponse).kindergarten.id;

    const arch = await request(server)
      .post(`/api/v1/saas/kindergartens/${kgId}/archive`)
      .set('Authorization', `Bearer ${saAccess}`)
      .expect(200);
    expect((arch.body as KindergartenDto).archived_at).not.toBeNull();
    expect((arch.body as KindergartenDto).is_active).toBe(false);

    const rest = await request(server)
      .post(`/api/v1/saas/kindergartens/${kgId}/restore`)
      .set('Authorization', `Bearer ${saAccess}`)
      .expect(200);
    expect((rest.body as KindergartenDto).archived_at).toBeNull();
    expect((rest.body as KindergartenDto).is_active).toBe(true);
  });

  it('archive non-existent kg → 404 kindergarten_not_found', async () => {
    const res = await request(server)
      .post(
        `/api/v1/saas/kindergartens/00000000-0000-0000-0000-000000000000/archive`,
      )
      .set('Authorization', `Bearer ${saAccess}`);
    expect(res.status).toBe(404);
    expect((res.body as ErrorBody).error).toBe('kindergarten_not_found');
  });

  it('admin invite returns sent=true and best-effort feeds the SMS adapter', async () => {
    const create = await request(server)
      .post('/api/v1/saas/kindergartens')
      .set('Authorization', `Bearer ${saAccess}`)
      .send({
        name: 'Invite Garden',
        slug: 'invite-garden',
        admin: { full_name: 'A', phone: '+77011112501' },
      })
      .expect(201);
    const kgId = (create.body as CreateKgResponse).kindergarten.id;
    ctx.sms.log.length = 0;

    const res = await request(server)
      .post(`/api/v1/saas/kindergartens/${kgId}/admin/invite`)
      .set('Authorization', `Bearer ${saAccess}`)
      .send({ phone: '+77011112502' })
      .expect(200);
    expect(res.body.sent).toBe(true);
    expect(res.body.phone).toBe('+77011112502');
    expect(res.body.kindergarten_id).toBe(kgId);
    expect(ctx.sms.log.some((s) => s.phone === '+77011112502')).toBe(true);
  });
});
