/**
 * B24 / K9 — Kaspi parent-pay happy-path (e2e).
 *
 * Boots the app with legacy `PAYMENT_PROVIDER='kaspi'` so the registry enables
 * the live `KaspiPaymentProvider`, and overrides the Kaspi HTTP boundary
 * (`KaspiHttpClient`) with a URL-routing fake:
 *
 *   POST /remote/create  → { Data: { QrOperationId, RecreateDeepLink } }
 *   GET  /remote/details → { Data: { Status: 'Processed' } }
 *
 * An ACTIVE `kaspi_merchant_session` is seeded for the kg (creds encrypted via
 * the real `CryptoCipherPort`, real EC P-256 keypair) so signing in
 * createPayment / getPaymentStatus does not throw.
 *
 * Scenarios:
 *   - Parent pays a kaspi_pay invoice → 201 with payment_id + deeplink; the
 *     payment row goes `processing` with provider_txn_id = QrOperationId.
 *   - Settlement driven directly via
 *     `KaspiPaymentStatusPollerService.pollOnce` (no BullMQ timing) → invoice
 *     `paid`, payment `completed`.
 *   - Negative: provider:'mock' while PAYMENT_PROVIDER=kaspi → 400
 *     payment_provider_unavailable.
 *   - Negative: provider:'kaspi_pay' without kaspi_phone_number → 422
 *     kaspi_phone_required.
 *
 * Runs only under `npm run test:e2e` (testRegex `test/.*\.e2e-spec\.ts$`).
 * Requires docker postgres + a dev Redis.
 */
import 'reflect-metadata';
import type { Server } from 'node:http';
import * as crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import {
  ClassSerializerInterceptor,
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '@/app.module';
import { SmsPort } from '@/modules/auth/sms.port';
import { MockSmsAdapter } from '@/modules/auth/infrastructure/adapters/mock-sms.adapter';
import { CryptoCipherPort } from '@/shared-kernel/application/ports/crypto-cipher.port';
import { KaspiPaymentStatusPollerService } from '@/modules/billing/kaspi-payment-status-poller.service';
import {
  KaspiFetch,
  KaspiHttpClient,
  KaspiHttpResponse,
} from '@/modules/billing/infrastructure/payment-provider/kaspi/kaspi-http.client';
import { RedisService } from '@/redis/redis.service';
import { AllConfigType } from '@/config/config.type';
import validationOptions from '@/utils/validation-options';
import { ResolvePromisesInterceptor } from '@/utils/serializer.interceptor';
import { closeCleanupDataSource, flushRedis, truncateAll } from './helpers/app';

const SUPER_ADMIN_EMAIL = 'super-kaspi@shyraq.test';
const SUPER_ADMIN_PASSWORD = 'admin12345';
const TEST_KASPI_KEY_HEX = 'c'.repeat(64);

function isoFuture(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/** URL-routing fake KaspiHttpClient (no network). */
class FakeKaspiHttpClient extends KaspiHttpClient {
  qrOp = `qr_${randomUUID()}`;
  readonly calls: Array<{ method: string; url: string }> = [];
  constructor() {
    super(undefined as unknown as KaspiFetch);
  }
  override request(
    method: 'GET' | 'POST',
    url: string,
  ): Promise<KaspiHttpResponse> {
    this.calls.push({ method, url });
    if (url.includes('/remote/create')) {
      return Promise.resolve({
        status: 200,
        json: {
          Data: {
            QrOperationId: this.qrOp,
            RecreateDeepLink: `kaspi://pay/${this.qrOp}`,
          },
        },
        setCookie: [],
      });
    }
    if (url.includes('/remote/details')) {
      return Promise.resolve({
        status: 200,
        json: { Data: { Status: 'Processed' } },
        setCookie: [],
      });
    }
    return Promise.resolve({ status: 200, json: { Data: {} }, setCookie: [] });
  }
}

/**
 * Re-seed the `kaspi_global_config` singleton (id=1) after a truncate. The
 * Kaspi adapter's `getConfig()` throws `kaspi_global_config_missing` without
 * it. Idempotent (ON CONFLICT DO NOTHING).
 */
async function ensureKaspiGlobalConfig(ds: DataSource): Promise<void> {
  await ds.transaction(async (m) => {
    await m.query(`SET LOCAL app.bypass_rls = 'true'`);
    await m.query(`
      INSERT INTO kaspi_global_config
        (id, app_version, app_build, platform_ver, model, brand,
         ua_native, ua_browser, entrance_url, mtoken_url, qrpay_url, updated_by)
      VALUES
        (1, '4.110.1', '1076', '18.5', 'iPhone17,3', 'Apple',
         'Kaspi%20Pay/1076 CFNetwork/3826.500.131 Darwin/24.5.0',
         'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Mobile/15E148',
         'https://entrance-pay.kaspi.kz', 'https://mtoken.kaspi.kz',
         'https://qrpay.kaspi.kz', NULL)
      ON CONFLICT (id) DO NOTHING
    `);
  });
}

function generateDeviceKeypairJson(): string {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  return JSON.stringify({
    privateKey: privateKey
      .export({ type: 'pkcs8', format: 'der' })
      .toString('base64'),
    publicKey: publicKey
      .export({ type: 'spki', format: 'der' })
      .toString('base64'),
  });
}

interface CreatedKgResp {
  kindergarten: { id: string; slug: string };
  staff_member: { id: string; user_id: string };
  user: { id: string; phone: string };
}

describe('B24 Kaspi parent-pay (e2e)', () => {
  let app: INestApplication;
  let server: Server;
  let dataSource: DataSource;
  let redis: RedisService;
  let cipher: CryptoCipherPort;
  let poller: KaspiPaymentStatusPollerService;
  let fakeHttp: FakeKaspiHttpClient;
  let jwtService: JwtService;
  let jwtSecret: string;
  let saAccess: string;
  let saUserId: string;
  let prevProvider: string | undefined;
  let prevProviders: string | undefined;

  // ── auth + seed helpers (mirror billing.e2e) ─────────────────────────────

  async function mintToken(opts: {
    sub: string;
    role: string;
    kindergartenId: string;
  }): Promise<string> {
    return jwtService.signAsync(
      {
        sub: opts.sub,
        role: opts.role,
        kindergarten_id: opts.kindergartenId,
        jti: randomUUID(),
      },
      { secret: jwtSecret, expiresIn: '1h' },
    );
  }

  async function seedSuperAdmin(): Promise<void> {
    const id = randomUUID();
    saUserId = id;
    const hash = await bcrypt.hash(SUPER_ADMIN_PASSWORD, 4);
    await dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      await m.query(
        `INSERT INTO saas_users (id, email, full_name, password_hash, role, is_active)
         VALUES ($1, $2, 'SA', $3, 'super_admin', true)`,
        [id, SUPER_ADMIN_EMAIL, hash],
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
        name: `Kaspi-Test KG ${slug}`,
        slug,
        admin: { full_name: 'Admin', phone },
      })
      .expect(201);
    const body = res.body as CreatedKgResp;
    const adminToken = await mintToken({
      sub: body.user.id,
      role: 'admin',
      kindergartenId: body.kindergarten.id,
    });
    return {
      kgId: body.kindergarten.id,
      userId: body.user.id,
      adminToken,
    };
  }

  async function seedUser(phone: string): Promise<string> {
    const id = randomUUID();
    await dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      await m.query(
        `INSERT INTO users (id, phone, full_name) VALUES ($1, $2, '')`,
        [id, phone],
      );
    });
    return id;
  }

  async function createChild(
    adminToken: string,
    payload: { full_name: string; date_of_birth: string },
  ): Promise<string> {
    const res = await request(server)
      .post('/api/v1/children')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(payload)
      .expect(201);
    return res.body.id as string;
  }

  async function seedApprovedGuardian(
    kgId: string,
    childId: string,
    userId: string,
  ): Promise<void> {
    await dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      await m.query(
        `INSERT INTO child_guardians
           (id, kindergarten_id, child_id, user_id, role, status,
            can_pickup, has_approval_rights, permissions, approved_by, approved_at)
         VALUES ($1, $2, $3, $4, 'primary', 'approved', true, true, '{}'::jsonb, $4, now())`,
        [randomUUID(), kgId, childId, userId],
      );
    });
  }

  /** Seed an ACTIVE kaspi_merchant_session for the kg with real encrypted creds. */
  async function seedActiveKaspiSession(
    kgId: string,
    userId: string,
  ): Promise<void> {
    const deviceKeypairEnc = cipher.encryptString(generateDeviceKeypairJson());
    const vtokenSecretEnc = cipher.encryptString('');
    await dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      await m.query(
        `INSERT INTO kaspi_merchant_session
           (id, kindergarten_id, connected_by_user_id, status, cashier_phone,
            kaspi_profile_id, token_sn, vtoken_secret_enc, device_keypair_enc,
            ecdh_keypair_enc, device_id, install_id, pin_hash, last_checked_at)
         VALUES ($1, $2, $3, 'active', '77001234567', 'profile-1', 'token-sn-1',
                 $4, $5, $5, $6, $7, 'pin-hash', now())`,
        [
          randomUUID(),
          kgId,
          userId,
          vtokenSecretEnc,
          deviceKeypairEnc,
          randomUUID().toUpperCase(),
          randomUUID().toUpperCase(),
        ],
      );
    });
  }

  async function createOneOffInvoice(
    adminToken: string,
    childId: string,
    amountDue: number,
  ): Promise<string> {
    const today = isoToday();
    const res = await request(server)
      .post('/api/v1/admin/invoices')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        child_id: childId,
        invoice_type: 'other',
        amount_due: amountDue,
        due_date: isoFuture(10),
        period_start: today,
        period_end: today,
        description: 'Kaspi test invoice',
        line_items: [
          { description: 'Test line', quantity: 1, unit_price: amountDue },
        ],
      })
      .expect(201);
    return res.body.id as string;
  }

  async function readPayment(
    paymentId: string,
  ): Promise<{ status: string; provider_txn_id: string | null }> {
    return dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      const rows = (await m.query(
        `SELECT status, provider_txn_id FROM payments WHERE id = $1`,
        [paymentId],
      )) as Array<{ status: string; provider_txn_id: string | null }>;
      return rows[0];
    });
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  beforeAll(async () => {
    prevProvider = process.env.PAYMENT_PROVIDER;
    prevProviders = process.env.PAYMENT_PROVIDERS;
    delete process.env.PAYMENT_PROVIDERS;
    process.env.PAYMENT_PROVIDER = 'kaspi';
    process.env.KASPI_ENCRYPTION_KEY = TEST_KASPI_KEY_HEX;
    fakeHttp = new FakeKaspiHttpClient();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SmsPort)
      .useClass(MockSmsAdapter)
      .overrideProvider(KaspiHttpClient)
      .useValue(fakeHttp)
      .compile();

    app = moduleRef.createNestApplication({ bufferLogs: true });
    const configService = app.get(ConfigService<AllConfigType>);
    app.setGlobalPrefix(
      configService.getOrThrow('app.apiPrefix', { infer: true }),
      { exclude: ['/'] },
    );
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(new ValidationPipe(validationOptions));
    app.useGlobalInterceptors(
      new ResolvePromisesInterceptor(),
      new ClassSerializerInterceptor(app.get(Reflector)),
    );
    await app.init();

    server = app.getHttpServer() as Server;
    dataSource = app.get(DataSource);
    redis = app.get(RedisService);
    cipher = app.get(CryptoCipherPort);
    poller = app.get(KaspiPaymentStatusPollerService);
    jwtSecret = configService.getOrThrow<string>('auth.jwtAccessSecret', {
      infer: true,
    });
    jwtService = app.get(JwtService);
  });

  afterAll(async () => {
    await truncateAll(dataSource);
    await flushRedis(redis);
    await app.close();
    await closeCleanupDataSource();
    if (prevProvider === undefined) {
      delete process.env.PAYMENT_PROVIDER;
    } else {
      process.env.PAYMENT_PROVIDER = prevProvider;
    }
    if (prevProviders === undefined) {
      delete process.env.PAYMENT_PROVIDERS;
    } else {
      process.env.PAYMENT_PROVIDERS = prevProviders;
    }
    delete process.env.KASPI_ENCRYPTION_KEY;
  });

  beforeEach(async () => {
    await truncateAll(dataSource);
    await flushRedis(redis);
    // truncateAll wipes the migration-seeded kaspi_global_config singleton;
    // re-seed it so the Kaspi adapter's getConfig() resolves.
    await ensureKaspiGlobalConfig(dataSource);
    await seedSuperAdmin();
    saAccess = await loginSuperAdmin();
  });

  // ── happy path ──────────────────────────────────────────────────────────

  it('initiates a kaspi_pay payment (201 + deeplink, processing) and settles via the poller', async () => {
    const a = await createKgWithAdmin('kaspi-pay', '+77020200001');
    await seedActiveKaspiSession(a.kgId, a.userId);
    const parentId = await seedUser('+77020200002');
    const childId = await createChild(a.adminToken, {
      full_name: 'Kaspi Child',
      date_of_birth: '2021-02-14',
    });
    await seedApprovedGuardian(a.kgId, childId, parentId);

    const parentToken = await mintToken({
      sub: parentId,
      role: 'parent',
      kindergartenId: a.kgId,
    });

    const invoiceId = await createOneOffInvoice(a.adminToken, childId, 25000);

    // Parent initiates a kaspi_pay payment.
    const payRes = await request(server)
      .post(`/api/v1/parent/invoices/${invoiceId}/pay`)
      .set('Authorization', `Bearer ${parentToken}`)
      .send({
        payment_mode: 'full',
        provider: 'kaspi_pay',
        kaspi_phone_number: '77001234567',
        idempotency_key: randomUUID(),
        return_url: 'https://app.shyraq.kz/payment/return',
      })
      .expect(201);

    expect(payRes.body.payment_id).toBeDefined();
    expect(payRes.body.deeplink).toBe(`kaspi://pay/${fakeHttp.qrOp}`);
    const paymentId = payRes.body.payment_id as string;

    // Payment is processing, provider_txn_id = QrOperationId from remote/create.
    const afterInit = await readPayment(paymentId);
    expect(afterInit.status).toBe('processing');
    expect(afterInit.provider_txn_id).toBe(fakeHttp.qrOp);

    // Invoice still pending (no webhook, settlement is poller-driven).
    const invBefore = await request(server)
      .get(`/api/v1/admin/invoices/${invoiceId}`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .expect(200);
    expect(invBefore.body.status).toBe('pending');

    // Drive settlement directly (no BullMQ timing). remote/details → Processed.
    const pollResult = await poller.pollOnce(a.kgId, paymentId);
    expect(pollResult.outcome).toBe('settled');

    // Invoice paid, payment completed.
    const invAfter = await request(server)
      .get(`/api/v1/admin/invoices/${invoiceId}`)
      .set('Authorization', `Bearer ${a.adminToken}`)
      .expect(200);
    expect(invAfter.body.status).toBe('paid');

    const afterSettle = await readPayment(paymentId);
    expect(afterSettle.status).toBe('completed');
  });

  // ── negatives ─────────────────────────────────────────────────────────────

  it('rejects provider:mock while PAYMENT_PROVIDER=kaspi → 400 payment_provider_unavailable', async () => {
    const a = await createKgWithAdmin('kaspi-mismatch', '+77020200011');
    await seedActiveKaspiSession(a.kgId, a.userId);
    const parentId = await seedUser('+77020200012');
    const childId = await createChild(a.adminToken, {
      full_name: 'Kaspi Child 2',
      date_of_birth: '2021-03-14',
    });
    await seedApprovedGuardian(a.kgId, childId, parentId);

    const parentToken = await mintToken({
      sub: parentId,
      role: 'parent',
      kindergartenId: a.kgId,
    });
    const invoiceId = await createOneOffInvoice(a.adminToken, childId, 10000);

    const res = await request(server)
      .post(`/api/v1/parent/invoices/${invoiceId}/pay`)
      .set('Authorization', `Bearer ${parentToken}`)
      .send({
        payment_mode: 'full',
        provider: 'mock',
        idempotency_key: randomUUID(),
        return_url: 'https://app.shyraq.kz/payment/return',
      })
      .expect(400);
    expect(res.body.message).toBe('payment_provider_unavailable');
  });

  it('rejects provider:kaspi_pay without kaspi_phone_number → 422 validation', async () => {
    const a = await createKgWithAdmin('kaspi-nophone', '+77020200021');
    await seedActiveKaspiSession(a.kgId, a.userId);
    const parentId = await seedUser('+77020200022');
    const childId = await createChild(a.adminToken, {
      full_name: 'Kaspi Child 3',
      date_of_birth: '2021-04-14',
    });
    await seedApprovedGuardian(a.kgId, childId, parentId);

    const parentToken = await mintToken({
      sub: parentId,
      role: 'parent',
      kindergartenId: a.kgId,
    });
    const invoiceId = await createOneOffInvoice(a.adminToken, childId, 10000);

    // Missing kaspi_phone_number for provider=kaspi_pay is rejected by the DTO
    // (`@ValidateIf(provider==='kaspi_pay') @Matches`) via the ValidationPipe →
    // 422. The controller's 400 `kaspi_phone_required` guard is defense-in-depth
    // behind that validation (it only fires if the DTO ever lets a falsy phone
    // through). Either way the request is rejected before any provider call.
    const res = await request(server)
      .post(`/api/v1/parent/invoices/${invoiceId}/pay`)
      .set('Authorization', `Bearer ${parentToken}`)
      .send({
        payment_mode: 'full',
        provider: 'kaspi_pay',
        idempotency_key: randomUUID(),
        return_url: 'https://app.shyraq.kz/payment/return',
      })
      .expect(422);
    expect(JSON.stringify(res.body)).toContain('kaspi_phone_number');
  });

  // ── #4 — super-admin Kaspi global-config PUT ───────────────────────────────

  it('super-admin PUT /saas/kaspi/config returns 200 and persists updated_by as the saas_user (#4)', async () => {
    // Pre-fix the FK `kaspi_global_config.updated_by` pointed at `users(id)`,
    // but the super-admin lives in `saas_users` → every PUT 500'd. Migration
    // 1778710000000 repoints the FK to `saas_users(id)`; this asserts the PUT
    // now succeeds AND stamps updated_by with the super-admin's saas_users id.
    const res = await request(server)
      .put('/api/v1/saas/kaspi/config')
      .set('Authorization', `Bearer ${saAccess}`)
      .send({ app_build: '9999' })
      .expect(200);
    expect(res.body.app_build).toBe('9999');

    const rows = (await dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      return m.query(
        `SELECT app_build, updated_by FROM kaspi_global_config WHERE id = 1`,
      );
    })) as Array<{ app_build: string; updated_by: string | null }>;
    expect(rows[0].app_build).toBe('9999');
    expect(rows[0].updated_by).toBe(saUserId);
  });
});
