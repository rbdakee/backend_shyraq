import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { createTestApp, flushRedis, TestApp, truncateAll } from './helpers/app';

interface AuthBody {
  access_token: string;
}

interface CreatedKgResp {
  kindergarten: { id: string };
  user: { id: string; phone: string };
}

interface AdminRow {
  staff_member_id: string;
  user_id: string;
  full_name: string | null;
  phone: string | null;
  locale: string | null;
  is_active: boolean;
  hired_at: string | null;
  fired_at: string | null;
  created_at: string;
}

interface AddAdminResp {
  kindergarten_id: string;
  user: { id: string; phone: string; full_name: string; locale: string };
  staff_member: {
    id: string;
    role: string;
    is_active: boolean;
    hired_at: string | null;
    created_at: string;
  };
  invite_sms_sent: boolean;
}

interface ErrorBody {
  statusCode: number;
  error?: string;
  message?: string;
}

const SA_EMAIL = 'sa-kg-admins@shyraq.test';
const SA_PASSWORD = 'admin12345';
const SUPPORT_EMAIL = 'support-kg-admins@shyraq.test';
const SUPPORT_PASSWORD = 'support12345';

describe('SuperAdmin Kindergarten Admins — /api/v1/saas/kindergartens/:id/admins (e2e)', () => {
  let ctx: TestApp;
  let server: Server;
  let saAccess: string;
  let jwtService: JwtService;
  let jwtSecret: string;

  async function seedSaasUser(
    email: string,
    password: string,
    role: 'super_admin' | 'support',
  ): Promise<void> {
    const hash = await bcrypt.hash(password, 4);
    await ctx.dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      await m.query(
        `INSERT INTO saas_users (id, email, full_name, password_hash, role, is_active)
         VALUES ($1, $2, 'U', $3, $4, true)`,
        [randomUUID(), email, hash, role],
      );
    });
  }

  async function login(email: string, password: string): Promise<string> {
    const res = await request(server)
      .post('/api/v1/saas/auth/login')
      .send({ email, password })
      .expect(200);
    return (res.body as AuthBody).access_token;
  }

  /**
   * Signs a regular kindergarten-admin JWT (role='admin') with the same
   * secret AppModule uses — exercises the non-super forbidden path against
   * the @Roles('super_admin','support') controller.
   */
  function mintKgAdminAccess(sub: string, kindergartenId: string): string {
    return jwtService.sign(
      {
        sub,
        role: 'admin',
        kindergarten_id: kindergartenId,
        jti: randomUUID(),
      },
      { secret: jwtSecret, expiresIn: '1h' },
    );
  }

  async function createKg(slug: string, phone: string): Promise<CreatedKgResp> {
    const res = await request(server)
      .post('/api/v1/saas/kindergartens')
      .set('Authorization', `Bearer ${saAccess}`)
      .send({
        name: `Garden ${slug}`,
        slug,
        admin: { full_name: 'Owner Admin', phone },
      })
      .expect(201);
    return res.body as CreatedKgResp;
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
    await seedSaasUser(SA_EMAIL, SA_PASSWORD, 'super_admin');
    await seedSaasUser(SUPPORT_EMAIL, SUPPORT_PASSWORD, 'support');
    saAccess = await login(SA_EMAIL, SA_PASSWORD);
  });

  it('lists only the kindergarten’s own admins (cross-tenant isolation)', async () => {
    const kgA = await createKg('kga', '+77011110001');
    const kgB = await createKg('kgb', '+77011110002');

    const aRes = await request(server)
      .get(`/api/v1/saas/kindergartens/${kgA.kindergarten.id}/admins`)
      .set('Authorization', `Bearer ${saAccess}`)
      .expect(200);
    const aAdmins = aRes.body as AdminRow[];
    expect(Array.isArray(aAdmins)).toBe(true);
    expect(aAdmins).toHaveLength(1);
    expect(aAdmins[0].user_id).toBe(kgA.user.id);
    expect(aAdmins[0].phone).toBe('+77011110001');
    expect(aAdmins[0].full_name).toBe('Owner Admin');
    expect(aAdmins[0].locale).toBe('ru');
    expect(aAdmins[0].is_active).toBe(true);
    // kg_A admin must NOT include kg_B's admin user.
    expect(aAdmins.some((r) => r.user_id === kgB.user.id)).toBe(false);

    const bRes = await request(server)
      .get(`/api/v1/saas/kindergartens/${kgB.kindergarten.id}/admins`)
      .set('Authorization', `Bearer ${saAccess}`)
      .expect(200);
    const bAdmins = bRes.body as AdminRow[];
    expect(bAdmins).toHaveLength(1);
    expect(bAdmins[0].user_id).toBe(kgB.user.id);
    expect(bAdmins.some((r) => r.user_id === kgA.user.id)).toBe(false);
  });

  it('adds a new admin to kg_A and the list reflects it', async () => {
    const kgA = await createKg('kga-add', '+77011110010');
    ctx.sms.log.length = 0;

    const add = await request(server)
      .post(`/api/v1/saas/kindergartens/${kgA.kindergarten.id}/admins`)
      .set('Authorization', `Bearer ${saAccess}`)
      .send({ full_name: 'Second Admin', phone: '+77011110011', locale: 'kk' })
      .expect(201);
    const body = add.body as AddAdminResp;
    expect(body.kindergarten_id).toBe(kgA.kindergarten.id);
    expect(body.user.phone).toBe('+77011110011');
    expect(body.user.full_name).toBe('Second Admin');
    expect(body.user.locale).toBe('kk');
    expect(body.staff_member.role).toBe('admin');
    expect(body.staff_member.is_active).toBe(true);
    expect(body.invite_sms_sent).toBe(true);
    expect(ctx.sms.log.some((s) => s.phone === '+77011110011')).toBe(true);

    const list = await request(server)
      .get(`/api/v1/saas/kindergartens/${kgA.kindergarten.id}/admins`)
      .set('Authorization', `Bearer ${saAccess}`)
      .expect(200);
    expect((list.body as AdminRow[]).map((r) => r.phone).sort()).toEqual([
      '+77011110010',
      '+77011110011',
    ]);
  });

  it('409 admin_already_exists when re-adding the existing owner admin', async () => {
    const kgA = await createKg('kga-dup', '+77011110020');
    const res = await request(server)
      .post(`/api/v1/saas/kindergartens/${kgA.kindergarten.id}/admins`)
      .set('Authorization', `Bearer ${saAccess}`)
      .send({ full_name: 'Dup', phone: '+77011110020' });
    expect(res.status).toBe(409);
    expect((res.body as ErrorBody).error).toBe('admin_already_exists');
  });

  it('404 kindergarten_not_found for unknown kg (list + add)', async () => {
    const missing = '00000000-0000-0000-0000-000000000000';
    const listRes = await request(server)
      .get(`/api/v1/saas/kindergartens/${missing}/admins`)
      .set('Authorization', `Bearer ${saAccess}`);
    expect(listRes.status).toBe(404);
    expect((listRes.body as ErrorBody).error).toBe('kindergarten_not_found');

    const addRes = await request(server)
      .post(`/api/v1/saas/kindergartens/${missing}/admins`)
      .set('Authorization', `Bearer ${saAccess}`)
      .send({ full_name: 'X', phone: '+77011110030' });
    expect(addRes.status).toBe(404);
    expect((addRes.body as ErrorBody).error).toBe('kindergarten_not_found');
  });

  it('409 kindergarten_archived when adding to an archived kg', async () => {
    const kgA = await createKg('kga-arch', '+77011110040');
    await request(server)
      .post(`/api/v1/saas/kindergartens/${kgA.kindergarten.id}/archive`)
      .set('Authorization', `Bearer ${saAccess}`)
      .expect(200);

    const res = await request(server)
      .post(`/api/v1/saas/kindergartens/${kgA.kindergarten.id}/admins`)
      .set('Authorization', `Bearer ${saAccess}`)
      .send({ full_name: 'Late', phone: '+77011110041' });
    expect(res.status).toBe(409);
    expect((res.body as ErrorBody).error).toBe('kindergarten_archived');
  });

  it('support role is allowed (200/201)', async () => {
    const kgA = await createKg('kga-support', '+77011110050');
    const supportAccess = await login(SUPPORT_EMAIL, SUPPORT_PASSWORD);

    await request(server)
      .get(`/api/v1/saas/kindergartens/${kgA.kindergarten.id}/admins`)
      .set('Authorization', `Bearer ${supportAccess}`)
      .expect(200);

    const add = await request(server)
      .post(`/api/v1/saas/kindergartens/${kgA.kindergarten.id}/admins`)
      .set('Authorization', `Bearer ${supportAccess}`)
      .send({ full_name: 'By Support', phone: '+77011110051' });
    expect(add.status).toBe(201);
  });

  it('kindergarten-admin (non-super) role → 403', async () => {
    const kgA = await createKg('kga-403', '+77011110060');
    const kgAdminToken = mintKgAdminAccess(kgA.user.id, kgA.kindergarten.id);

    const listRes = await request(server)
      .get(`/api/v1/saas/kindergartens/${kgA.kindergarten.id}/admins`)
      .set('Authorization', `Bearer ${kgAdminToken}`);
    expect(listRes.status).toBe(403);

    const addRes = await request(server)
      .post(`/api/v1/saas/kindergartens/${kgA.kindergarten.id}/admins`)
      .set('Authorization', `Bearer ${kgAdminToken}`)
      .send({ full_name: 'Nope', phone: '+77011110061' });
    expect(addRes.status).toBe(403);
  });

  it('no bearer → 401', async () => {
    const kgA = await createKg('kga-401', '+77011110070');
    const listRes = await request(server).get(
      `/api/v1/saas/kindergartens/${kgA.kindergarten.id}/admins`,
    );
    expect(listRes.status).toBe(401);
    const addRes = await request(server)
      .post(`/api/v1/saas/kindergartens/${kgA.kindergarten.id}/admins`)
      .send({ full_name: 'X', phone: '+77011110071' });
    expect(addRes.status).toBe(401);
  });

  it('is_active filter splits active vs deactivated admins', async () => {
    const kgA = await createKg('kga-filter', '+77011110080');
    // Add a second admin then deactivate the kg to flip all staff inactive,
    // then restore the kg (staff stay inactive — restore does NOT reactivate).
    await request(server)
      .post(`/api/v1/saas/kindergartens/${kgA.kindergarten.id}/admins`)
      .set('Authorization', `Bearer ${saAccess}`)
      .send({ full_name: 'Second', phone: '+77011110081' })
      .expect(201);
    await request(server)
      .post(`/api/v1/saas/kindergartens/${kgA.kindergarten.id}/archive`)
      .set('Authorization', `Bearer ${saAccess}`)
      .expect(200);
    await request(server)
      .post(`/api/v1/saas/kindergartens/${kgA.kindergarten.id}/restore`)
      .set('Authorization', `Bearer ${saAccess}`)
      .expect(200);

    const all = await request(server)
      .get(`/api/v1/saas/kindergartens/${kgA.kindergarten.id}/admins`)
      .set('Authorization', `Bearer ${saAccess}`)
      .expect(200);
    expect((all.body as AdminRow[]).length).toBe(2);

    const activeOnly = await request(server)
      .get(
        `/api/v1/saas/kindergartens/${kgA.kindergarten.id}/admins?is_active=true`,
      )
      .set('Authorization', `Bearer ${saAccess}`)
      .expect(200);
    expect((activeOnly.body as AdminRow[]).length).toBe(0);

    const inactiveOnly = await request(server)
      .get(
        `/api/v1/saas/kindergartens/${kgA.kindergarten.id}/admins?is_active=false`,
      )
      .set('Authorization', `Bearer ${saAccess}`)
      .expect(200);
    expect((inactiveOnly.body as AdminRow[]).length).toBe(2);
    expect(
      (inactiveOnly.body as AdminRow[]).every((r) => r.is_active === false),
    ).toBe(true);
  });
});
