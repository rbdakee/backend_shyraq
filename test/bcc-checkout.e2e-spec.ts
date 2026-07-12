import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AllConfigType } from '@/config/config.type';
import { BccHttpClient } from '@/modules/billing/infrastructure/payment-provider/bcc/bcc-http.client';
import { BccReconciliationService } from '@/modules/billing/bcc-reconciliation.service';
import {
  closeCleanupDataSource,
  createTestApp,
  flushRedis,
  TestApp,
  truncateAll,
} from './helpers/app';

const SUPER_ADMIN_EMAIL = 'bcc-checkout@shyraq.test';
const SUPER_ADMIN_PASSWORD = 'admin12345';
const COMPONENT_1 = '690B5589573ACB3608DB7395A319B175';
const COMPONENT_2 = '02BBF98BB3411445D15498E2DC22E3E1';

interface CreatedKg {
  kindergarten: { id: string };
  staff_member: { id: string; user_id: string };
  user: { id: string; phone: string };
}

describe('BCC checkout bridge (e2e)', () => {
  let ctx: TestApp;
  let server: Server;
  let jwt: JwtService;
  let jwtSecret: string;
  let saAccess: string;
  let kgId: string;
  let adminToken: string;
  let parentId: string;
  let parentToken: string;
  let childId: string;
  let invoiceId: string;
  let notifyUrl: string;
  let notifyUsername: string;
  let notifyPassword: string;
  const previousProvider = process.env.PAYMENT_PROVIDER;
  const previousProviders = process.env.PAYMENT_PROVIDERS;
  const previousEncryptionKey = process.env.KASPI_ENCRYPTION_KEY;
  const previousBackendDomain = process.env.BACKEND_DOMAIN;
  const previousProxyHops = process.env.BCC_TRUSTED_PROXY_HOPS;

  beforeAll(async () => {
    delete process.env.PAYMENT_PROVIDERS;
    process.env.PAYMENT_PROVIDER = 'bcc';
    process.env.KASPI_ENCRYPTION_KEY = '22'.repeat(32);
    process.env.BACKEND_DOMAIN = 'https://api.example.test';
    process.env.BCC_TRUSTED_PROXY_HOPS = '1';
    ctx = await createTestApp();
    server = ctx.server;
    jwt = ctx.app.get(JwtService);
    const config = ctx.app.get(ConfigService<AllConfigType>);
    jwtSecret = config.getOrThrow<string>('auth.jwtAccessSecret', {
      infer: true,
    });
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
    restoreEnv('PAYMENT_PROVIDER', previousProvider);
    restoreEnv('PAYMENT_PROVIDERS', previousProviders);
    restoreEnv('KASPI_ENCRYPTION_KEY', previousEncryptionKey);
    restoreEnv('BACKEND_DOMAIN', previousBackendDomain);
    restoreEnv('BCC_TRUSTED_PROXY_HOPS', previousProxyHops);
  });

  beforeEach(async () => {
    await truncateAll(ctx.dataSource);
    await flushRedis(ctx.redis);
    await seedSuperAdmin();
    saAccess = await loginSuperAdmin();
    const kg = await createKindergarten();
    kgId = kg.kgId;
    adminToken = kg.adminToken;
    parentId = await seedUser('+77020201002');
    parentToken = await mintToken(parentId, 'parent', kgId);
    childId = await createChild(adminToken);
    await seedApprovedGuardian(kgId, childId, parentId);
    invoiceId = await createInvoice(adminToken, childId);
    await activateBccAccount();
  });

  it('runs profile → pay → idempotent bridge → one-time consume without card data', async () => {
    await request(server)
      .get('/api/v1/parent/payment-profile')
      .set('Authorization', `Bearer ${parentToken}`)
      .expect(200, {
        billing_phone: '+77020201002',
        billing_address: null,
        saved: false,
      });

    const methods = await request(server)
      .get(`/api/v1/parent/invoices/${invoiceId}/payment-methods`)
      .set('Authorization', `Bearer ${parentToken}`)
      .expect(200);
    expect(methods.body.providers).toEqual([
      expect.objectContaining({ provider: 'bcc', kind: 'redirect' }),
    ]);

    const idempotencyKey = randomUUID();
    const payload = {
      payment_mode: 'full',
      provider: 'bcc',
      idempotency_key: idempotencyKey,
      billing_phone: '+77011234567',
      billing_address: 'г. Алматы, ул. Абая, 10',
      save_billing_profile: true,
    };
    const initiated = await request(server)
      .post(`/api/v1/parent/invoices/${invoiceId}/pay`)
      .set('Authorization', `Bearer ${parentToken}`)
      .send(payload)
      .expect(201);
    const paymentId = initiated.body.payment_id as string;
    const redirectUrl = initiated.body.redirect_url as string;
    expect(redirectUrl).toMatch(
      /^https:\/\/api\.example\.test:443\/api\/v1\/payments\/bcc\/checkout\/[A-Za-z0-9_-]{43}$/,
    );

    const retried = await request(server)
      .post(`/api/v1/parent/invoices/${invoiceId}/pay`)
      .set('Authorization', `Bearer ${parentToken}`)
      .send(payload)
      .expect(201);
    expect(retried.body).toMatchObject({
      payment_id: paymentId,
      redirect_url: redirectUrl,
    });

    const profile = await request(server)
      .get('/api/v1/parent/payment-profile')
      .set('Authorization', `Bearer ${parentToken}`)
      .expect(200);
    expect(profile.body).toEqual({
      billing_phone: '+77011234567',
      billing_address: 'г. Алматы, ул. Абая, 10',
      saved: true,
    });

    const checkoutPath = new URL(redirectUrl).pathname;
    const bridge = await request(server)
      .get(checkoutPath)
      .set('X-Forwarded-For', '203.0.113.10')
      .expect(200);
    expect(bridge.headers['cache-control']).toContain('no-store');
    expect(bridge.headers['content-security-policy']).toContain(
      'form-action https://test3ds.bcc.kz:5445',
    );
    expect(bridge.text).toContain('method="post"');
    expect(bridge.text).toContain(
      'action="https://test3ds.bcc.kz:5445/cgi-bin/cgi_link"',
    );
    expect(bridge.text).toContain('name="CLIENT_IP" value="203.0.113.10"');
    expect(bridge.text).toContain("input.name = 'M_INFO'");
    expect(bridge.text).not.toMatch(/name="(?:CARD|EXP|CVC2)"/);

    const consumed = await request(server).get(checkoutPath).expect(410);
    expect(consumed.body.error).toBe('bcc_checkout_expired');

    const expiredRetry = await request(server)
      .post(`/api/v1/parent/invoices/${invoiceId}/pay`)
      .set('Authorization', `Bearer ${parentToken}`)
      .send(payload)
      .expect(410);
    expect(expiredRetry.body.error).toBe('bcc_checkout_expired');

    const stored = await readPayment(paymentId);
    expect(stored.status).toBe('processing');
    expect(stored.provider_txn_id).toMatch(/^\d{32}$/);
    expect(stored.provider_payload).toMatchObject({
      order: stored.provider_txn_id,
      merchant_id: '00000001',
      terminal_id: '88888881',
      transaction_type: '1',
    });
    expect(stored.provider_payload).not.toHaveProperty('redirect_url');
    expect(JSON.stringify(stored.provider_payload)).not.toContain(
      '+77011234567',
    );
    expect(JSON.stringify(stored.provider_payload)).not.toContain('ул. Абая');
  });

  it('rejects client return URLs and card fields before creating a payment', async () => {
    await request(server)
      .post(`/api/v1/parent/invoices/${invoiceId}/pay`)
      .set('Authorization', `Bearer ${parentToken}`)
      .send({
        payment_mode: 'full',
        provider: 'bcc',
        idempotency_key: randomUUID(),
        billing_phone: '+77011234567',
        billing_address: 'Алматы',
        return_url: 'https://attacker.example/return',
      })
      .expect(400);

    const cardResponse = await request(server)
      .post(`/api/v1/parent/invoices/${invoiceId}/pay`)
      .set('Authorization', `Bearer ${parentToken}`)
      .send({
        payment_mode: 'full',
        provider: 'bcc',
        idempotency_key: randomUUID(),
        billing_phone: '+77011234567',
        billing_address: 'Алматы',
        pan: '4111111111111111',
        cvc: '123',
      })
      .expect(422);
    expect(JSON.stringify(cardResponse.body)).toContain(
      'card_data_not_accepted',
    );

    const count = await paymentCount();
    expect(count).toBe(0);
  });

  it('settles one payment and invoice under concurrent duplicate callbacks', async () => {
    const initiated = await request(server)
      .post(`/api/v1/parent/invoices/${invoiceId}/pay`)
      .set('Authorization', `Bearer ${parentToken}`)
      .send({
        payment_mode: 'full',
        provider: 'bcc',
        idempotency_key: randomUUID(),
        billing_phone: '+77011234567',
        billing_address: 'Алматы',
      })
      .expect(201);
    const paymentId = initiated.body.payment_id as string;
    const before = await readPayment(paymentId);
    const callbackPath = new URL(notifyUrl).pathname;
    const callback = {
      ACTION: '0',
      RC: '00',
      RC_TEXT: 'Approved',
      ORDER: before.provider_txn_id,
      AMOUNT: '350.00',
      CURRENCY: '398',
      TERMINAL: '88888881',
      MERCHANT: '00000001',
      RRN: '618721285042',
      INT_REF: '6D1C6D9B343B89CA',
      P_SIGN: 'not-stored',
    };
    const auth = `Basic ${Buffer.from(
      `${notifyUsername}:${notifyPassword}`,
    ).toString('base64')}`;

    await request(server)
      .post(callbackPath)
      .type('form')
      .set(
        'Authorization',
        `Basic ${Buffer.from(`${notifyUsername}:wrong`).toString('base64')}`,
      )
      .send(callback)
      .expect(401);

    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        request(server)
          .post(callbackPath)
          .type('form')
          .set('Authorization', auth)
          .send(callback),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([
      200, 200, 200, 200,
    ]);

    const stored = await readPayment(paymentId);
    expect(stored.status).toBe('completed');
    expect(stored.provider_payload).toMatchObject({
      order: before.provider_txn_id,
      action: '0',
      rc: '00',
      rc_text: 'Approved',
      rrn: '618721285042',
      int_ref: '6D1C6D9B343B89CA',
      source: 'bcc_callback',
    });
    expect(JSON.stringify(stored.provider_payload)).not.toContain('not-stored');

    const state = await readSettlementState(paymentId);
    expect(state).toEqual({
      payment_status: 'completed',
      invoice_status: 'paid',
      completed_count: 1,
      balance: '350.00',
    });
  });

  it('recovers a lost callback through TRTYPE=90 reconciliation', async () => {
    const initiated = await request(server)
      .post(`/api/v1/parent/invoices/${invoiceId}/pay`)
      .set('Authorization', `Bearer ${parentToken}`)
      .send({
        payment_mode: 'full',
        provider: 'bcc',
        idempotency_key: randomUUID(),
        billing_phone: '+77011234567',
        billing_address: 'Алматы',
      })
      .expect(201);
    const paymentId = initiated.body.payment_id as string;
    await makeReconciliationDue(paymentId);

    const result = await ctx.app
      .get(BccReconciliationService)
      .reconcileOnce(kgId, paymentId);
    expect(result).toEqual({ outcome: 'settled', nextAt: null });

    const state = await readSettlementState(paymentId);
    expect(state).toEqual({
      payment_status: 'completed',
      invoice_status: 'paid',
      completed_count: 1,
      balance: '350.00',
    });
    const stored = await readPayment(paymentId);
    expect(stored.provider_payload).toMatchObject({
      action: '0',
      rc: '00',
      source: 'bcc_reconciliation',
      tran_trtype: '1',
    });
  });

  it('persists a decline and isolates an unknown ORDER', async () => {
    const initiated = await request(server)
      .post(`/api/v1/parent/invoices/${invoiceId}/pay`)
      .set('Authorization', `Bearer ${parentToken}`)
      .send({
        payment_mode: 'full',
        provider: 'bcc',
        idempotency_key: randomUUID(),
        billing_phone: '+77011234567',
        billing_address: 'Алматы',
      })
      .expect(201);
    const paymentId = initiated.body.payment_id as string;
    const stored = await readPayment(paymentId);
    const callbackPath = new URL(notifyUrl).pathname;
    const auth = `Basic ${Buffer.from(
      `${notifyUsername}:${notifyPassword}`,
    ).toString('base64')}`;
    const decline = {
      ACTION: '2',
      RC: '51',
      RC_TEXT: 'Declined',
      ORDER: stored.provider_txn_id,
      AMOUNT: '350.00',
      CURRENCY: '398',
      TERMINAL: '88888881',
      MERCHANT: '00000001',
      RRN: '618721285043',
      INT_REF: 'ABD83948C1ABC568',
    };

    await request(server)
      .post(callbackPath)
      .type('form')
      .set('Authorization', auth)
      .send(decline)
      .expect(200, 'OK');
    await request(server)
      .post(callbackPath)
      .type('form')
      .set('Authorization', auth)
      .send(decline)
      .expect(200, 'OK');

    const failed = await readPayment(paymentId);
    expect(failed.status).toBe('failed');
    expect(failed.provider_payload).toMatchObject({
      action: '2',
      rc: '51',
      rc_text: 'Declined',
      rrn: '618721285043',
      int_ref: 'ABD83948C1ABC568',
      failure_reason: 'bcc_rc_51',
    });

    const unknown = await request(server)
      .post(callbackPath)
      .type('form')
      .set('Authorization', auth)
      .send({ ...decline, ORDER: '9999999999999' })
      .expect(404);
    expect(unknown.body).toMatchObject({
      statusCode: 404,
      message: 'payment_not_found',
    });
    expect((await readPayment(paymentId)).status).toBe('failed');
  });

  it('refunds a completed BCC payment through admin approval and TRTYPE=14', async () => {
    const initiated = await request(server)
      .post(`/api/v1/parent/invoices/${invoiceId}/pay`)
      .set('Authorization', `Bearer ${parentToken}`)
      .send({
        payment_mode: 'full',
        provider: 'bcc',
        idempotency_key: randomUUID(),
        billing_phone: '+77011234567',
        billing_address: 'Алматы',
      })
      .expect(201);
    const paymentId = initiated.body.payment_id as string;
    const before = await readPayment(paymentId);
    const order = before.provider_txn_id as string;

    const callbackPath = new URL(notifyUrl).pathname;
    const auth = `Basic ${Buffer.from(
      `${notifyUsername}:${notifyPassword}`,
    ).toString('base64')}`;
    await request(server)
      .post(callbackPath)
      .type('form')
      .set('Authorization', auth)
      .send({
        ACTION: '0',
        RC: '00',
        RC_TEXT: 'Approved',
        ORDER: order,
        AMOUNT: '350.00',
        CURRENCY: '398',
        TERMINAL: '88888881',
        MERCHANT: '00000001',
        RRN: '618721285042',
        INT_REF: '6D1C6D9B343B89CA',
      })
      .expect(200, 'OK');

    const executeSpy = ctx.app.get(BccHttpClient).execute as jest.Mock;
    executeSpy.mockClear();

    const created = await request(server)
      .post('/api/v1/admin/refunds')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ payment_id: paymentId, amount: 350, reason: 'parent requested' })
      .expect(201);
    const refundId = created.body.id as string;
    expect(created.body.status).toBe('pending');

    await request(server)
      .post(`/api/v1/admin/refunds/${refundId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
      .expect(200);

    const processed = await request(server)
      .post(`/api/v1/admin/refunds/${refundId}/process`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
      .expect(200);
    expect(processed.body.status).toBe('processed');
    expect(processed.body.provider_ref).toBe(`bcc_refund_${order}`);

    // The signed TRTYPE=14 carried the original settlement identifiers.
    const refundCall = executeSpy.mock.calls.find(
      (call) =>
        (call[1] as Record<string, string> | undefined)?.TRTYPE === '14',
    );
    expect(refundCall).toBeDefined();
    expect(refundCall?.[0]).toBe('test');
    expect(refundCall?.[1]).toMatchObject({
      TRTYPE: '14',
      ORDER: order,
      ORG_AMOUNT: '350.00',
      AMOUNT: '350.00',
      CURRENCY: '398',
      RRN: '618721285042',
      INT_REF: '6D1C6D9B343B89CA',
      TERMINAL: '88888881',
    });
    expect((refundCall?.[1] as Record<string, string>).P_SIGN).toMatch(
      /^[0-9A-F]{40}$/,
    );

    // Payment, invoice and ledger are fully unwound exactly once.
    const state = await readSettlementState(paymentId);
    expect(state).toEqual({
      payment_status: 'refunded',
      invoice_status: 'refunded',
      completed_count: 0,
      balance: '0.00',
    });
  });

  it('processes an approved refund exactly once under concurrent /process calls', async () => {
    const initiated = await request(server)
      .post(`/api/v1/parent/invoices/${invoiceId}/pay`)
      .set('Authorization', `Bearer ${parentToken}`)
      .send({
        payment_mode: 'full',
        provider: 'bcc',
        idempotency_key: randomUUID(),
        billing_phone: '+77011234567',
        billing_address: 'Алматы',
      })
      .expect(201);
    const paymentId = initiated.body.payment_id as string;
    const order = (await readPayment(paymentId)).provider_txn_id as string;

    const callbackPath = new URL(notifyUrl).pathname;
    const auth = `Basic ${Buffer.from(
      `${notifyUsername}:${notifyPassword}`,
    ).toString('base64')}`;
    await request(server)
      .post(callbackPath)
      .type('form')
      .set('Authorization', auth)
      .send({
        ACTION: '0',
        RC: '00',
        RC_TEXT: 'Approved',
        ORDER: order,
        AMOUNT: '350.00',
        CURRENCY: '398',
        TERMINAL: '88888881',
        MERCHANT: '00000001',
        RRN: '618721285042',
        INT_REF: '6D1C6D9B343B89CA',
      })
      .expect(200, 'OK');

    const executeSpy = ctx.app.get(BccHttpClient).execute as jest.Mock;
    executeSpy.mockClear();

    const created = await request(server)
      .post('/api/v1/admin/refunds')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ payment_id: paymentId, amount: 350, reason: 'duplicate click' })
      .expect(201);
    const refundId = created.body.id as string;
    await request(server)
      .post(`/api/v1/admin/refunds/${refundId}/approve`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
      .expect(200);

    // Two admins click "process" at the same instant. The per-refund advisory
    // lock must serialise them: one settles, the other sees a terminal state.
    const results = await Promise.all([
      request(server)
        .post(`/api/v1/admin/refunds/${refundId}/process`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({}),
      request(server)
        .post(`/api/v1/admin/refunds/${refundId}/process`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({}),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);

    // Exactly one TRTYPE=14 reached BCC — no double refund at the bank.
    const refundCalls = executeSpy.mock.calls.filter(
      (call) =>
        (call[1] as Record<string, string> | undefined)?.TRTYPE === '14',
    );
    expect(refundCalls).toHaveLength(1);

    const state = await readSettlementState(paymentId);
    expect(state).toMatchObject({
      payment_status: 'refunded',
      invoice_status: 'refunded',
      balance: '0.00',
    });
  });

  async function activateBccAccount(): Promise<void> {
    const created = await request(server)
      .put(`/api/v1/saas/kindergartens/${kgId}/bcc/account`)
      .set('Authorization', `Bearer ${saAccess}`)
      .send({
        merchant_id: '00000001',
        terminal_id: '88888881',
        merchant_name: 'SHYRAQ TEST',
        environment: 'test',
        mac_key_component_1: COMPONENT_1,
        mac_key_component_2: COMPONENT_2,
      })
      .expect(200);
    notifyUrl = created.body.notify_url as string;
    notifyUsername = created.body.notify_username as string;
    notifyPassword = created.body.notify_password as string;
    await request(server)
      .post(`/api/v1/saas/kindergartens/${kgId}/bcc/account/check`)
      .set('Authorization', `Bearer ${saAccess}`)
      .expect(200);
  }

  async function seedSuperAdmin(): Promise<string> {
    const id = randomUUID();
    const hash = await bcrypt.hash(SUPER_ADMIN_PASSWORD, 4);
    await ctx.dataSource.transaction(async (manager) => {
      await manager.query(`SET LOCAL app.bypass_rls = 'true'`);
      await manager.query(
        `INSERT INTO saas_users
           (id, email, full_name, password_hash, role, is_active)
         VALUES ($1, $2, 'BCC Checkout E2E', $3, 'super_admin', true)`,
        [id, SUPER_ADMIN_EMAIL, hash],
      );
    });
    return id;
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

  async function createKindergarten(): Promise<{
    kgId: string;
    adminToken: string;
  }> {
    const response = await request(server)
      .post('/api/v1/saas/kindergartens')
      .set('Authorization', `Bearer ${saAccess}`)
      .send({
        name: 'BCC Checkout Garden',
        slug: `bcc-checkout-${randomUUID()}`,
        admin: {
          full_name: 'BCC Admin',
          phone: '+77020201001',
        },
      })
      .expect(201);
    const body = response.body as CreatedKg;
    return {
      kgId: body.kindergarten.id,
      adminToken: await mintToken(body.user.id, 'admin', body.kindergarten.id),
    };
  }

  async function mintToken(
    sub: string,
    role: string,
    kindergartenId: string,
  ): Promise<string> {
    return jwt.signAsync(
      {
        sub,
        role,
        kindergarten_id: kindergartenId,
        jti: randomUUID(),
      },
      { secret: jwtSecret, expiresIn: '1h' },
    );
  }

  async function seedUser(phone: string): Promise<string> {
    const id = randomUUID();
    await ctx.dataSource.transaction(async (manager) => {
      await manager.query(`SET LOCAL app.bypass_rls = 'true'`);
      await manager.query(
        `INSERT INTO users (id, phone, full_name) VALUES ($1, $2, 'BCC Parent')`,
        [id, phone],
      );
    });
    return id;
  }

  async function createChild(token: string): Promise<string> {
    const response = await request(server)
      .post('/api/v1/children')
      .set('Authorization', `Bearer ${token}`)
      .send({
        full_name: 'BCC Child',
        date_of_birth: '2021-02-14',
      })
      .expect(201);
    return response.body.id as string;
  }

  async function seedApprovedGuardian(
    kindergartenId: string,
    targetChildId: string,
    userId: string,
  ): Promise<void> {
    await ctx.dataSource.transaction(async (manager) => {
      await manager.query(`SET LOCAL app.bypass_rls = 'true'`);
      await manager.query(
        `INSERT INTO child_guardians
           (id, kindergarten_id, child_id, user_id, role, status,
            can_pickup, has_approval_rights, permissions, approved_by, approved_at)
         VALUES ($1, $2, $3, $4, 'primary', 'approved', true, true,
                 '{}'::jsonb, $4, now())`,
        [randomUUID(), kindergartenId, targetChildId, userId],
      );
    });
  }

  async function createInvoice(
    token: string,
    targetChildId: string,
  ): Promise<string> {
    const today = new Date().toISOString().slice(0, 10);
    const due = new Date();
    due.setUTCDate(due.getUTCDate() + 10);
    const response = await request(server)
      .post('/api/v1/admin/invoices')
      .set('Authorization', `Bearer ${token}`)
      .send({
        child_id: targetChildId,
        invoice_type: 'other',
        amount_due: 350,
        due_date: due.toISOString().slice(0, 10),
        period_start: today,
        period_end: today,
        description: 'BCC checkout test',
        line_items: [
          { description: 'Test line', quantity: 1, unit_price: 350 },
        ],
      })
      .expect(201);
    return response.body.id as string;
  }

  async function readPayment(paymentId: string): Promise<{
    status: string;
    provider_txn_id: string | null;
    provider_payload: Record<string, unknown>;
  }> {
    return ctx.dataSource.transaction(async (manager) => {
      await manager.query(`SET LOCAL app.bypass_rls = 'true'`);
      const rows = (await manager.query(
        `SELECT status, provider_txn_id, provider_payload
           FROM payments WHERE id = $1`,
        [paymentId],
      )) as Array<{
        status: string;
        provider_txn_id: string | null;
        provider_payload: Record<string, unknown>;
      }>;
      return rows[0];
    });
  }

  async function paymentCount(): Promise<number> {
    return ctx.dataSource.transaction(async (manager) => {
      await manager.query(`SET LOCAL app.bypass_rls = 'true'`);
      const rows = (await manager.query(
        `SELECT count(*)::int AS count FROM payments`,
      )) as Array<{ count: number }>;
      return rows[0].count;
    });
  }

  async function makeReconciliationDue(paymentId: string): Promise<void> {
    await ctx.dataSource.transaction(async (manager) => {
      await manager.query(`SET LOCAL app.bypass_rls = 'true'`);
      await manager.query(
        `UPDATE payments
            SET next_reconciliation_at = now() - interval '1 second'
          WHERE id = $1`,
        [paymentId],
      );
    });
  }

  async function readSettlementState(paymentId: string): Promise<{
    payment_status: string;
    invoice_status: string;
    completed_count: number;
    balance: string;
  }> {
    return ctx.dataSource.transaction(async (manager) => {
      await manager.query(`SET LOCAL app.bypass_rls = 'true'`);
      const rows = (await manager.query(
        `SELECT p.status AS payment_status,
                i.status AS invoice_status,
                (
                  SELECT count(*)::int
                    FROM payments counted
                   WHERE counted.invoice_id = i.id
                     AND counted.status = 'completed'
                ) AS completed_count,
                pa.balance::text AS balance
           FROM payments p
           JOIN invoices i ON i.id = p.invoice_id
           JOIN payment_accounts pa ON pa.id = i.payment_account_id
          WHERE p.id = $1`,
        [paymentId],
      )) as Array<{
        payment_status: string;
        invoice_status: string;
        completed_count: number;
        balance: string;
      }>;
      return rows[0];
    });
  }
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
