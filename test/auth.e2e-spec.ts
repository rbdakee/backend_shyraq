import type { Server } from 'node:http';
import request from 'supertest';
import { createTestApp, flushRedis, TestApp, truncateAll } from './helpers/app';

interface AuthBody {
  access_token: string;
  refresh_token: string | null;
  token_type: string;
  expires_in: number;
  pending_role_select: boolean;
  roles: {
    role: string;
    kindergarten_id: string | null;
    group_id: string | null;
  }[];
  kindergartens: { id: string; name: string; slug: string }[];
  user: {
    id: string;
    phone: string;
    full_name: string;
    avatar_url: string | null;
    iin: string | null;
    date_of_birth: string | null;
    locale: string;
  };
}

interface ErrorBody {
  statusCode: number;
  error?: string;
  message?: string;
}

const PARENT_PHONE = '+77011110001';
const STAFF_PHONE = '+77011110002';

describe('Auth — /api/v1/auth/* (e2e)', () => {
  let ctx: TestApp;
  let server: Server;

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
  });

  function extractCode(): string {
    const last = ctx.sms.lastSent;
    if (!last) throw new Error('no SMS captured');
    const m = /(\d{6})/.exec(last.message);
    if (!m) throw new Error('no 6-digit code in message');
    return m[1];
  }

  it('parent OTP request + verify issues a complete token pair', async () => {
    const reqRes = await request(server)
      .post('/api/v1/auth/otp/request')
      .send({ phone: PARENT_PHONE, app: 'parent' });
    expect(reqRes.status).toBe(202);
    expect(reqRes.body).toMatchObject({ sent: true, resend_after_sec: 60 });

    const code = extractCode();
    const verifyRes = await request(server)
      .post('/api/v1/auth/otp/verify')
      .send({ phone: PARENT_PHONE, code, app: 'parent' });
    expect(verifyRes.status).toBe(200);
    const body = verifyRes.body as AuthBody;
    expect(typeof body.access_token).toBe('string');
    expect(body.access_token.length).toBeGreaterThan(0);
    expect(body.refresh_token).not.toBeNull();
    expect(body.refresh_token!.length).toBe(64);
    expect(body.pending_role_select).toBe(false);
    expect(body.token_type).toBe('Bearer');
    expect(body.roles).toEqual([
      { role: 'parent', kindergarten_id: null, group_id: null },
    ]);
    expect(body.user.phone).toBe(PARENT_PHONE);
  });

  it('three wrong codes lock the phone with otp_locked', async () => {
    await request(server)
      .post('/api/v1/auth/otp/request')
      .send({ phone: STAFF_PHONE, app: 'parent' })
      .expect(202);

    const wrong1 = await request(server)
      .post('/api/v1/auth/otp/verify')
      .send({ phone: STAFF_PHONE, code: '111111', app: 'parent' });
    expect(wrong1.status).toBe(400);
    expect((wrong1.body as ErrorBody).error).toBe('invalid_otp');

    const wrong2 = await request(server)
      .post('/api/v1/auth/otp/verify')
      .send({ phone: STAFF_PHONE, code: '222222', app: 'parent' });
    expect(wrong2.status).toBe(400);

    const wrong3 = await request(server)
      .post('/api/v1/auth/otp/verify')
      .send({ phone: STAFF_PHONE, code: '333333', app: 'parent' });
    expect(wrong3.status).toBe(429);
    expect((wrong3.body as ErrorBody).error).toBe('otp_locked');
  });

  it('verify without prior request returns otp_expired_or_missing', async () => {
    const res = await request(server)
      .post('/api/v1/auth/otp/verify')
      .send({ phone: PARENT_PHONE, code: '123456', app: 'parent' });
    expect(res.status).toBe(400);
    expect((res.body as ErrorBody).error).toBe('otp_expired_or_missing');
  });

  it('successful verify consumes the OTP — replay returns otp_expired_or_missing', async () => {
    await request(server)
      .post('/api/v1/auth/otp/request')
      .send({ phone: PARENT_PHONE, app: 'parent' })
      .expect(202);
    const code = extractCode();
    await request(server)
      .post('/api/v1/auth/otp/verify')
      .send({ phone: PARENT_PHONE, code, app: 'parent' })
      .expect(200);

    const replay = await request(server)
      .post('/api/v1/auth/otp/verify')
      .send({ phone: PARENT_PHONE, code, app: 'parent' });
    expect(replay.status).toBe(400);
    expect((replay.body as ErrorBody).error).toBe('otp_expired_or_missing');
  });

  it('phone hits the rate limit after 5 OTP requests in the same window', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await request(server)
        .post('/api/v1/auth/otp/request')
        .send({ phone: PARENT_PHONE, app: 'parent' });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5)).toEqual([202, 202, 202, 202, 202]);
    expect(statuses[5]).toBe(429);
  });

  it('rejects badly formatted phone via DTO validation', async () => {
    const res = await request(server)
      .post('/api/v1/auth/otp/request')
      .send({ phone: 'not-a-phone', app: 'parent' });
    expect(res.status).toBe(422);
  });

  it('refresh rotates the token and the old refresh becomes invalid', async () => {
    await request(server)
      .post('/api/v1/auth/otp/request')
      .send({ phone: PARENT_PHONE, app: 'parent' })
      .expect(202);
    const code = extractCode();
    const verify = await request(server)
      .post('/api/v1/auth/otp/verify')
      .send({ phone: PARENT_PHONE, code, app: 'parent' })
      .expect(200);
    const oldRefresh = (verify.body as AuthBody).refresh_token!;

    const rotated = await request(server)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: oldRefresh })
      .expect(200);
    const newRefresh = (rotated.body as AuthBody).refresh_token!;
    expect(newRefresh).not.toBe(oldRefresh);

    const replay = await request(server)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: oldRefresh });
    expect(replay.status).toBe(401);
  });

  it('logout revokes refresh + blocklists access JTI (idempotent)', async () => {
    await request(server)
      .post('/api/v1/auth/otp/request')
      .send({ phone: PARENT_PHONE, app: 'parent' })
      .expect(202);
    const code = extractCode();
    const verify = await request(server)
      .post('/api/v1/auth/otp/verify')
      .send({ phone: PARENT_PHONE, code, app: 'parent' })
      .expect(200);
    const access = (verify.body as AuthBody).access_token;
    const refresh = (verify.body as AuthBody).refresh_token!;

    const logout = await request(server)
      .post('/api/v1/auth/logout')
      .set('Authorization', 'Bearer ' + access)
      .send({ refreshToken: refresh });
    expect(logout.status).toBe(204);

    const refreshAfter = await request(server)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: refresh });
    expect(refreshAfter.status).toBe(401);

    const me = await request(server)
      .get('/api/v1/users/me')
      .set('Authorization', 'Bearer ' + access);
    expect(me.status).toBe(401);
  });

  it('selectRole rejects regular (non-pending) JWT with role_select_not_required', async () => {
    await request(server)
      .post('/api/v1/auth/otp/request')
      .send({ phone: PARENT_PHONE, app: 'parent' })
      .expect(202);
    const code = extractCode();
    const verify = await request(server)
      .post('/api/v1/auth/otp/verify')
      .send({ phone: PARENT_PHONE, code, app: 'parent' })
      .expect(200);
    const access = (verify.body as AuthBody).access_token;

    const res = await request(server)
      .post('/api/v1/auth/role/select')
      .set('Authorization', 'Bearer ' + access)
      .send({
        kindergartenId: '5b3d3b8a-7f4f-4d2a-9c84-9a7c1c1c1c1c',
        role: 'teacher',
      });
    expect(res.status).toBe(403);
    expect((res.body as ErrorBody).error).toBe('role_select_not_required');
  });
});
