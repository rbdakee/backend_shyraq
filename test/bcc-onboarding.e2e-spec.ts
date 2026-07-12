import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { BccHttpClient } from '@/modules/billing/infrastructure/payment-provider/bcc/bcc-http.client';
import {
  closeCleanupDataSource,
  createTestApp,
  flushRedis,
  TestApp,
  truncateAll,
} from './helpers/app';

const SUPER_ADMIN_EMAIL = 'bcc-onboarding@shyraq.test';
const SUPER_ADMIN_PASSWORD = 'admin12345';
const COMPONENT_1 = '690B5589573ACB3608DB7395A319B175';
const COMPONENT_2 = '02BBF98BB3411445D15498E2DC22E3E1';

describe('BCC merchant onboarding (e2e)', () => {
  let ctx: TestApp;
  let server: Server;
  let accessToken: string;
  let kgA: string;
  let kgB: string;
  const previousEncryptionKey = process.env.KASPI_ENCRYPTION_KEY;
  const previousBackendDomain = process.env.BACKEND_DOMAIN;

  beforeAll(async () => {
    process.env.KASPI_ENCRYPTION_KEY = '11'.repeat(32);
    process.env.BACKEND_DOMAIN = 'https://api.example.test:443';
    ctx = await createTestApp();
    server = ctx.server;
    jest.spyOn(ctx.app.get(BccHttpClient), 'execute').mockResolvedValue({
      httpStatus: 200,
      httpOk: true,
      fields: { ACTION: '0', RC: '00', RC_TEXT: 'APPROVED' },
      diagnostics: {
        action: '0',
        rc: '00',
        rcText: 'APPROVED',
        order: null,
        rrn: null,
        intRef: null,
      },
    });
  });

  afterAll(async () => {
    await truncateAll(ctx.dataSource);
    await flushRedis(ctx.redis);
    await ctx.app.close();
    await closeCleanupDataSource();
    if (previousEncryptionKey === undefined) {
      delete process.env.KASPI_ENCRYPTION_KEY;
    } else {
      process.env.KASPI_ENCRYPTION_KEY = previousEncryptionKey;
    }
    if (previousBackendDomain === undefined) {
      delete process.env.BACKEND_DOMAIN;
    } else {
      process.env.BACKEND_DOMAIN = previousBackendDomain;
    }
  });

  beforeEach(async () => {
    await truncateAll(ctx.dataSource);
    await flushRedis(ctx.redis);
    await seedSuperAdmin();
    accessToken = await loginSuperAdmin();
    kgA = await createKindergarten('bcc-e2e-a', '+77011117001');
    kgB = await createKindergarten('bcc-e2e-b', '+77011117002');
  });

  it('provisions, hides secrets on GET, checks connection and disables', async () => {
    const created = await upsert(kgA).expect(200);
    expect(created.body).toEqual(
      expect.objectContaining({
        connected: false,
        status: 'draft',
        merchant_id: 'SHYRAQ_TEST_MERCHANT',
        terminal_id: '88888881',
        environment: 'test',
        notify_url: expect.stringMatching(
          /^https:\/\/api\.example\.test:443\/api\/v1\/webhooks\/payments\/bcc\//,
        ),
        notify_username: expect.any(String),
        notify_password: expect.any(String),
      }),
    );
    expect(created.body).not.toHaveProperty('mac_key_component_1');
    expect(created.body).not.toHaveProperty('mac_key_component_2');

    const updated = await upsert(kgA).expect(200);
    expect(updated.body).not.toHaveProperty('notify_url');
    expect(updated.body).not.toHaveProperty('notify_username');
    expect(updated.body).not.toHaveProperty('notify_password');

    const fetched = await request(server)
      .get(`/api/v1/saas/kindergartens/${kgA}/bcc/account`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(fetched.body).not.toHaveProperty('mac_key_enc');
    expect(fetched.body).not.toHaveProperty('callback_token_hash');
    expect(fetched.body).not.toHaveProperty('callback_token_enc');
    expect(fetched.body).not.toHaveProperty('notify_password_hash');

    await request(server)
      .get(`/api/v1/saas/kindergartens/${kgB}/bcc/account`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(404);

    const checked = await request(server)
      .post(`/api/v1/saas/kindergartens/${kgA}/bcc/account/check`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(checked.body).toEqual({
      connected: true,
      status: 'active',
      checked_at: expect.any(String),
      result: {
        success: true,
        action: '0',
        rc: '00',
        rc_text: 'APPROVED',
      },
    });

    await request(server)
      .post(`/api/v1/saas/kindergartens/${kgA}/bcc/account/disable`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200, { status: 'disabled' });
  });

  it('rotates MAC and callback credentials without echoing stored secrets', async () => {
    const created = await upsert(kgA).expect(200);

    const callback = await request(server)
      .post(
        `/api/v1/saas/kindergartens/${kgA}/bcc/account/rotate-callback-credentials`,
      )
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(callback.body.notify_url).not.toBe(created.body.notify_url);
    expect(callback.body.notify_password).toEqual(expect.any(String));

    const rotated = await request(server)
      .post(`/api/v1/saas/kindergartens/${kgA}/bcc/account/rotate-mac`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        mac_key_component_1: COMPONENT_1,
        mac_key_component_2: COMPONENT_2,
      })
      .expect(200);
    expect(rotated.body.status).toBe('draft');
    expect(rotated.body).not.toHaveProperty('mac_key_enc');
  });

  it('rejects invalid MAC components and non-SaaS callers', async () => {
    await request(server)
      .put(`/api/v1/saas/kindergartens/${kgA}/bcc/account`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        merchant_id: 'SHYRAQ_TEST_MERCHANT',
        terminal_id: '88888881',
        environment: 'test',
        mac_key_component_1: 'invalid',
        mac_key_component_2: COMPONENT_2,
      })
      .expect(422);

    await upsert(kgA, 'not-a-valid-token').expect(401);
  });

  function upsert(kindergartenId: string, token = accessToken) {
    return request(server)
      .put(`/api/v1/saas/kindergartens/${kindergartenId}/bcc/account`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        merchant_id: 'SHYRAQ_TEST_MERCHANT',
        terminal_id: '88888881',
        merchant_name: 'Shyraq Test',
        environment: 'test',
        mac_key_component_1: COMPONENT_1,
        mac_key_component_2: COMPONENT_2,
      });
  }

  async function seedSuperAdmin(): Promise<void> {
    const hash = await bcrypt.hash(SUPER_ADMIN_PASSWORD, 4);
    await ctx.dataSource.transaction(async (manager) => {
      await manager.query(`SET LOCAL app.bypass_rls = 'true'`);
      await manager.query(
        `INSERT INTO saas_users
           (id, email, full_name, password_hash, role, is_active)
         VALUES ($1, $2, 'BCC E2E', $3, 'super_admin', true)`,
        [randomUUID(), SUPER_ADMIN_EMAIL, hash],
      );
    });
  }

  async function loginSuperAdmin(): Promise<string> {
    const response = await request(server)
      .post('/api/v1/saas/auth/login')
      .send({
        email: SUPER_ADMIN_EMAIL,
        password: SUPER_ADMIN_PASSWORD,
      })
      .expect(200);
    return response.body.access_token as string;
  }

  async function createKindergarten(
    slug: string,
    phone: string,
  ): Promise<string> {
    const response = await request(server)
      .post('/api/v1/saas/kindergartens')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        name: `Garden ${slug}`,
        slug,
        admin: {
          full_name: `Admin ${slug}`,
          phone,
        },
      })
      .expect(201);
    return response.body.kindergarten.id as string;
  }
});
