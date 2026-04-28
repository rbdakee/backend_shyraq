import type { Server } from 'node:http';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createTestApp, flushRedis, TestApp, truncateAll } from './helpers/app';

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

interface ErrorBody {
  statusCode: number;
  error?: string;
  message?: string;
}

interface CreatedKgResp {
  kindergarten: { id: string; slug: string };
  staff_member: { id: string; user_id: string };
  user: { id: string; phone: string };
}

const SUPER_ADMIN_EMAIL = 'super-kgadmin@shyraq.test';
const SUPER_ADMIN_PASSWORD = 'admin12345';

describe('Kindergarten (Admin) — /api/v1/kindergartens/me (e2e)', () => {
  let ctx: TestApp;
  let server: Server;
  let saAccess: string;
  let jwtService: JwtService;
  let jwtSecret: string;

  /**
   * Mints an admin access token directly. AuthService.selectRole() still
   * rejects everything in P3 (the role-select flow lands in P4 alongside
   * staff-aware role assembly), so to exercise the admin-scoped endpoints
   * we sign a JWT with the same secret AppModule uses. The runtime guard
   * stack (JwtAuthGuard → KindergartenScopeGuard → RolesGuard +
   * TenantContextInterceptor) treats it identically to a token issued via
   * /auth/role/select once that flow exists.
   */
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

  async function createKgWithAdmin(
    slug: string,
    phone: string,
  ): Promise<{
    kgId: string;
    userId: string;
    adminToken: string;
  }> {
    const create = await request(server)
      .post('/api/v1/saas/kindergartens')
      .set('Authorization', `Bearer ${saAccess}`)
      .send({
        name: 'Test Garden',
        slug,
        admin: { full_name: 'Admin', phone },
      })
      .expect(201);
    const body = create.body as CreatedKgResp;
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

  it('GET /kindergartens/me returns admin’s own kg', async () => {
    const { kgId, adminToken } = await createKgWithAdmin(
      'me-kg-1',
      '+77011113001',
    );
    const res = await request(server)
      .get('/api/v1/kindergartens/me')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const body = res.body as KindergartenDto;
    expect(body.id).toBe(kgId);
    expect(body.slug).toBe('me-kg-1');
  });

  it('GET /kindergartens/me without bearer → 401', async () => {
    const res = await request(server).get('/api/v1/kindergartens/me');
    expect(res.status).toBe(401);
  });

  it('PATCH /kindergartens/me/settings replaces non-fiscal settings', async () => {
    const { adminToken } = await createKgWithAdmin('me-kg-2', '+77011113002');
    const res = await request(server)
      .patch('/api/v1/kindergartens/me/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ settings: { timezone: 'Asia/Almaty', currency: 'KZT' } })
      .expect(200);
    expect((res.body as KindergartenDto).settings).toEqual({
      timezone: 'Asia/Almaty',
      currency: 'KZT',
    });
  });

  it('PATCH /kindergartens/me/settings rejects fiscal_* keys with 403', async () => {
    const { adminToken } = await createKgWithAdmin('me-kg-3', '+77011113003');
    const res = await request(server)
      .patch('/api/v1/kindergartens/me/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ settings: { fiscal_ofd_provider: 'kassa24' } });
    expect(res.status).toBe(403);
    expect((res.body as ErrorBody).error).toBe('fiscal_settings_forbidden');
  });

  it('cross-tenant: admin of KG-A cannot read KG-B via /kindergartens/me', async () => {
    const a = await createKgWithAdmin('iso-a', '+77011113010');
    const b = await createKgWithAdmin('iso-b', '+77011113011');

    const aRes = await request(server)
      .get('/api/v1/kindergartens/me')
      .set('Authorization', `Bearer ${a.adminToken}`)
      .expect(200);
    expect((aRes.body as KindergartenDto).id).toBe(a.kgId);
    expect((aRes.body as KindergartenDto).id).not.toBe(b.kgId);

    const bRes = await request(server)
      .get('/api/v1/kindergartens/me')
      .set('Authorization', `Bearer ${b.adminToken}`)
      .expect(200);
    expect((bRes.body as KindergartenDto).id).toBe(b.kgId);
  });

  it('admin token cannot reach the SuperAdmin surface (403)', async () => {
    const { adminToken } = await createKgWithAdmin('iso-c', '+77011113020');
    const res = await request(server)
      .get('/api/v1/saas/kindergartens')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(403);
  });
});
