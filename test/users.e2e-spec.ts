import type { Server } from 'node:http';
import request from 'supertest';
import { createTestApp, flushRedis, TestApp, truncateAll } from './helpers/app';

interface AuthBody {
  access_token: string;
  refresh_token: string | null;
  user: { id: string; phone: string; full_name: string };
}

interface UserBody {
  id: string;
  phone: string;
  full_name: string;
  avatar_url: string | null;
  iin: string | null;
  date_of_birth: string | null;
  locale: string;
}

const PARENT_PHONE = '+77011110099';

describe('Users — /api/v1/users/me (e2e)', () => {
  let ctx: TestApp;
  let server: Server;

  async function loginAsParent(): Promise<{ access: string; userId: string }> {
    await request(server)
      .post('/api/v1/auth/otp/request')
      .send({ phone: PARENT_PHONE, app: 'parent' })
      .expect(202);
    const last = ctx.sms.lastSent;
    if (!last) throw new Error('no SMS captured');
    const m = /(\d{6})/.exec(last.message);
    if (!m) throw new Error('no code in SMS');
    const code = m[1];
    const verify = await request(server)
      .post('/api/v1/auth/otp/verify')
      .send({ phone: PARENT_PHONE, code, app: 'parent' })
      .expect(200);
    const body = verify.body as AuthBody;
    return { access: body.access_token, userId: body.user.id };
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
  });

  it('GET /users/me returns the current user profile', async () => {
    const { access, userId } = await loginAsParent();
    const res = await request(server)
      .get('/api/v1/users/me')
      .set('Authorization', 'Bearer ' + access);
    expect(res.status).toBe(200);
    const body = res.body as UserBody;
    expect(body.id).toBe(userId);
    expect(body.phone).toBe(PARENT_PHONE);
    expect(body.locale).toBe('ru');
  });

  it('GET /users/me without Bearer returns 401', async () => {
    const res = await request(server).get('/api/v1/users/me');
    expect(res.status).toBe(401);
  });

  it('PATCH /users/me updates the full name', async () => {
    const { access } = await loginAsParent();
    const res = await request(server)
      .patch('/api/v1/users/me')
      .set('Authorization', 'Bearer ' + access)
      .send({ fullName: 'Aisha Updated' });
    expect(res.status).toBe(200);
    expect((res.body as UserBody).full_name).toBe('Aisha Updated');
  });

  it('PATCH /users/me switches locale to kk', async () => {
    const { access } = await loginAsParent();
    const res = await request(server)
      .patch('/api/v1/users/me')
      .set('Authorization', 'Bearer ' + access)
      .send({ locale: 'kk' });
    expect(res.status).toBe(200);
    expect((res.body as UserBody).locale).toBe('kk');
  });

  it('PATCH /users/me rejects invalid IIN with 422', async () => {
    const { access } = await loginAsParent();
    const res = await request(server)
      .patch('/api/v1/users/me')
      .set('Authorization', 'Bearer ' + access)
      .send({ iin: 'not-numeric' });
    expect(res.status).toBe(422);
  });
});
