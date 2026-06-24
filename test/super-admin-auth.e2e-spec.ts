import type { Server } from 'node:http';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestApp, flushRedis, TestApp, truncateAll } from './helpers/app';

interface SuperAdminAuthBody {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  pending_role_select: false;
  roles: {
    role: string;
    kindergarten_id: string | null;
    group_id: string | null;
    specialist_type: string | null;
  }[];
}

interface ErrorBody {
  statusCode: number;
  error?: string;
  message?: string;
}

const ADMIN_EMAIL = 'admin@shyraq.test';
const ADMIN_PASSWORD = 'admin12345';

describe('SuperAdmin Auth — /api/v1/saas/auth/* (e2e)', () => {
  let ctx: TestApp;
  let server: Server;
  let adminId: string;

  async function seedAdmin(): Promise<void> {
    adminId = randomUUID();
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 4);
    // Direct insert via DataSource — saas_users has no public CREATE endpoint.
    // We use a transaction with bypass GUC so RLS plays nicely (saas_users
    // isn't tenant-scoped but the connecting role is non-superuser).
    await ctx.dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      await m.query(
        `INSERT INTO saas_users (id, email, full_name, password_hash, role, is_active)
         VALUES ($1, $2, 'Admin', $3, 'super_admin', true)`,
        [adminId, ADMIN_EMAIL, hash],
      );
    });
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
    await seedAdmin();
  });

  it('login with valid credentials returns tokens + super_admin role', async () => {
    const res = await request(server)
      .post('/api/v1/saas/auth/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    expect(res.status).toBe(200);
    const body = res.body as SuperAdminAuthBody;
    expect(body.access_token.length).toBeGreaterThan(0);
    expect(body.refresh_token.length).toBe(64);
    expect(body.roles).toEqual([
      {
        role: 'super_admin',
        kindergarten_id: null,
        group_id: null,
        specialist_type: null,
      },
    ]);
  });

  it('login with wrong password rejects with invalid_credentials (401)', async () => {
    const res = await request(server)
      .post('/api/v1/saas/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'wrong-pass' });
    expect(res.status).toBe(401);
    expect((res.body as ErrorBody).error).toBe('invalid_credentials');
  });

  it('login with unknown email rejects with invalid_credentials (401)', async () => {
    const res = await request(server)
      .post('/api/v1/saas/auth/login')
      .send({ email: 'nobody@nowhere.test', password: 'whatever1' });
    expect(res.status).toBe(401);
    expect((res.body as ErrorBody).error).toBe('invalid_credentials');
  });

  it('refresh rotates the SaaS refresh + invalidates the old one', async () => {
    const login = await request(server)
      .post('/api/v1/saas/auth/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
      .expect(200);
    const oldRefresh = (login.body as SuperAdminAuthBody).refresh_token;

    const rotated = await request(server)
      .post('/api/v1/saas/auth/refresh')
      .send({ refreshToken: oldRefresh })
      .expect(200);
    const newRefresh = (rotated.body as SuperAdminAuthBody).refresh_token;
    expect(newRefresh).not.toBe(oldRefresh);

    const replay = await request(server)
      .post('/api/v1/saas/auth/refresh')
      .send({ refreshToken: oldRefresh });
    expect(replay.status).toBe(401);
  });

  it('logout revokes refresh + blocklists access JTI', async () => {
    const login = await request(server)
      .post('/api/v1/saas/auth/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD })
      .expect(200);
    const access = (login.body as SuperAdminAuthBody).access_token;
    const refresh = (login.body as SuperAdminAuthBody).refresh_token;

    const logout = await request(server)
      .post('/api/v1/saas/auth/logout')
      .set('Authorization', 'Bearer ' + access)
      .send({ refreshToken: refresh });
    expect(logout.status).toBe(204);

    const refreshAfter = await request(server)
      .post('/api/v1/saas/auth/refresh')
      .send({ refreshToken: refresh });
    expect(refreshAfter.status).toBe(401);
  });

  it('rejects validation errors with 422', async () => {
    const res = await request(server)
      .post('/api/v1/saas/auth/login')
      .send({ email: 'not-an-email', password: 'short' });
    expect(res.status).toBe(422);
  });
});
