/**
 * B24 / K9 — Kaspi status-poller cross-tenant isolation integration spec.
 *
 * Two kindergartens (kg_A, kg_B), each with its OWN active Kaspi merchant
 * session and a `processing` kaspi_pay payment. Proves:
 *
 *   1. `PaymentRepository.findByIdCrossTenant` binds the kg filter:
 *      findByIdCrossTenant(kgA, paymentB.id) → null (kg mismatch),
 *      findByIdCrossTenant(kgB, paymentB.id) → the row.
 *   2. Driving `pollOnce(kgA, paymentA.id)` (mock details → Processed) settles
 *      ONLY kg_A — kg_B's payment + invoice stay untouched. The bypass-RLS GUC
 *      used to load the payment never leaks into kg_B's rows.
 *
 * Self-skips when `INTEGRATION_DB !== '1'`. Run with:
 *
 *   $env:DATABASE_PORT='55432'; $env:DATABASE_USERNAME='shyraq_app'
 *   $env:DATABASE_PASSWORD='shyraq_app'; $env:INTEGRATION_DB='1'
 *   npm test -- --testPathPattern='kaspi-payment-poller.cross-tenant'
 */
import 'reflect-metadata';
import * as crypto from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppModule } from '@/app.module';
import { SmsPort } from '@/modules/auth/sms.port';
import { MockSmsAdapter } from '@/modules/auth/infrastructure/adapters/mock-sms.adapter';
import { CryptoCipherPort } from '@/shared-kernel/application/ports/crypto-cipher.port';
import { KaspiPaymentStatusPollerService } from './kaspi-payment-status-poller.service';
import { PaymentRepository } from './infrastructure/persistence/payment.repository';
import {
  KaspiFetch,
  KaspiHttpClient,
  KaspiHttpResponse,
} from './infrastructure/payment-provider/kaspi/kaspi-http.client';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

const TEST_KASPI_KEY_HEX = 'b'.repeat(64);

class FakeKaspiHttpClient extends KaspiHttpClient {
  readonly calls: Array<{ method: string; url: string }> = [];
  constructor() {
    super(undefined as unknown as KaspiFetch);
  }
  override request(
    method: 'GET' | 'POST',
    url: string,
  ): Promise<KaspiHttpResponse> {
    this.calls.push({ method, url });
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

/**
 * Re-seed the `kaspi_global_config` singleton (id=1) if absent (cross-suite
 * TRUNCATE can wipe the migration seed; getConfig() throws without it).
 * Idempotent (ON CONFLICT DO NOTHING).
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

describeIntegration(
  'KaspiPaymentStatusPollerService — cross-tenant isolation (integration)',
  () => {
    jest.setTimeout(120_000);

    let app: INestApplication;
    let dataSource: DataSource;
    let poller: KaspiPaymentStatusPollerService;
    let paymentRepo: PaymentRepository;
    let cipher: CryptoCipherPort;

    beforeAll(async () => {
      process.env.KASPI_ENCRYPTION_KEY = TEST_KASPI_KEY_HEX;

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(SmsPort)
        .useClass(MockSmsAdapter)
        .overrideProvider(KaspiHttpClient)
        .useValue(new FakeKaspiHttpClient())
        .compile();

      app = moduleRef.createNestApplication({ bufferLogs: true });
      await app.init();

      dataSource = app.get(DataSource);
      poller = app.get(KaspiPaymentStatusPollerService);
      paymentRepo = app.get(PaymentRepository);
      // Re-seed the global Kaspi config wiped by cross-suite TRUNCATE so
      // getPaymentStatus → getConfig() resolves.
      await ensureKaspiGlobalConfig(dataSource);
      cipher = app.get(CryptoCipherPort);
    });

    afterAll(async () => {
      if (app) await app.close();
      delete process.env.KASPI_ENCRYPTION_KEY;
    });

    interface KgSeed {
      kgId: string;
      userId: string;
      childId: string;
      accountId: string;
      invoiceId: string;
      paymentId: string;
    }

    const seeded: KgSeed[] = [];

    async function seedKg(amount: number): Promise<KgSeed> {
      const kgId = randomUUID();
      const userId = randomUUID();
      const childId = randomUUID();
      const accountId = randomUUID();
      const invoiceId = randomUUID();
      const paymentId = randomUUID();
      const sessionId = randomUUID();
      const qrOp = `qr_${randomUUID()}`;
      const slug = `kaspi-xt-${kgId.slice(0, 8)}`;
      const phone = `+7700${kgId.replace(/-/g, '').slice(0, 7)}`;

      const deviceKeypairEnc = cipher.encryptString(
        generateDeviceKeypairJson(),
      );
      const vtokenSecretEnc = cipher.encryptString('');

      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(
          `INSERT INTO kindergartens (id, name, slug, is_active) VALUES ($1, 'Kaspi XT KG', $2, true)`,
          [kgId, slug],
        );
        await m.query(
          `INSERT INTO users (id, phone, full_name) VALUES ($1, $2, 'Kaspi Admin')`,
          [userId, phone],
        );
        await m.query(
          `INSERT INTO children (id, kindergarten_id, full_name, date_of_birth, status)
         VALUES ($1, $2, 'Kaspi Child', '2021-01-01', 'card_created')`,
          [childId, kgId],
        );
        await m.query(
          `INSERT INTO payment_accounts (id, kindergarten_id, child_id, balance) VALUES ($1, $2, $3, 0)`,
          [accountId, kgId, childId],
        );
        await m.query(
          `INSERT INTO invoices
           (id, kindergarten_id, child_id, payment_account_id, invoice_type,
            period_start, period_end, amount_due, amount_after_discount, status, due_date)
         VALUES ($1, $2, $3, $4, 'monthly', '2026-06-01', '2026-06-30', $5, $5, 'pending', '2026-06-10')`,
          [invoiceId, kgId, childId, accountId, amount],
        );
        await m.query(
          `INSERT INTO kaspi_merchant_session
           (id, kindergarten_id, connected_by_user_id, status, cashier_phone,
            kaspi_profile_id, token_sn, vtoken_secret_enc, device_keypair_enc,
            ecdh_keypair_enc, device_id, install_id, pin_hash, last_checked_at)
         VALUES ($1, $2, $3, 'active', '77001234567', 'profile-1', 'token-sn-1',
                 $4, $5, $5, $6, $7, 'pin-hash', now())`,
          [
            sessionId,
            kgId,
            userId,
            vtokenSecretEnc,
            deviceKeypairEnc,
            randomUUID().toUpperCase(),
            randomUUID().toUpperCase(),
          ],
        );
        await m.query(
          `INSERT INTO payments
           (id, kindergarten_id, invoice_id, child_id, payer_user_id, amount,
            provider, provider_txn_id, idempotency_key, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'kaspi_pay', $7, $8, 'processing', now(), now())`,
          [
            paymentId,
            kgId,
            invoiceId,
            childId,
            userId,
            amount,
            qrOp,
            randomUUID(),
          ],
        );
      });

      const s = { kgId, userId, childId, accountId, invoiceId, paymentId };
      seeded.push(s);
      return s;
    }

    afterEach(async () => {
      for (const s of seeded.splice(0)) {
        await dataSource.transaction(async (m) => {
          await m.query(`SET LOCAL app.bypass_rls = 'true'`);
          await m.query(`DELETE FROM payments WHERE kindergarten_id = $1`, [
            s.kgId,
          ]);
          await m.query(
            `DELETE FROM kaspi_merchant_session WHERE kindergarten_id = $1`,
            [s.kgId],
          );
          await m.query(`DELETE FROM invoices WHERE kindergarten_id = $1`, [
            s.kgId,
          ]);
          await m.query(
            `DELETE FROM payment_accounts WHERE kindergarten_id = $1`,
            [s.kgId],
          );
          await m.query(`DELETE FROM children WHERE kindergarten_id = $1`, [
            s.kgId,
          ]);
          await m.query(`DELETE FROM users WHERE id = $1`, [s.userId]);
          await m.query(`DELETE FROM kindergartens WHERE id = $1`, [s.kgId]);
        });
      }
    });

    async function readPaymentStatus(
      kgId: string,
      paymentId: string,
    ): Promise<string> {
      return dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        const rows = (await m.query(
          `SELECT status FROM payments WHERE id = $1 AND kindergarten_id = $2`,
          [paymentId, kgId],
        )) as Array<{ status: string }>;
        return rows[0].status;
      });
    }

    async function readInvoiceStatus(
      kgId: string,
      invoiceId: string,
    ): Promise<string> {
      return dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        const rows = (await m.query(
          `SELECT status FROM invoices WHERE id = $1 AND kindergarten_id = $2`,
          [invoiceId, kgId],
        )) as Array<{ status: string }>;
        return rows[0].status;
      });
    }

    async function readBalance(
      kgId: string,
      accountId: string,
    ): Promise<number> {
      return dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        const rows = (await m.query(
          `SELECT balance::text AS balance FROM payment_accounts WHERE id = $1 AND kindergarten_id = $2`,
          [accountId, kgId],
        )) as Array<{ balance: string }>;
        return Number(rows[0].balance);
      });
    }

    it('findByIdCrossTenant binds the kg filter — kgA cannot read paymentB, kgB can', async () => {
      const a = await seedKg(30000);
      const b = await seedKg(40000);

      // kg mismatch in the WHERE → null.
      expect(
        await paymentRepo.findByIdCrossTenant(a.kgId, b.paymentId),
      ).toBeNull();

      // Correct kg → the row.
      const found = await paymentRepo.findByIdCrossTenant(b.kgId, b.paymentId);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(b.paymentId);
      expect(found?.kindergartenId).toBe(b.kgId);
    });

    it('pollOnce(kgA) settles only kg_A — kg_B payment + invoice + balance untouched', async () => {
      const a = await seedKg(30000);
      const b = await seedKg(40000);

      const result = await poller.pollOnce(a.kgId, a.paymentId);
      expect(result.outcome).toBe('settled');

      // kg_A settled.
      expect(await readPaymentStatus(a.kgId, a.paymentId)).toBe('completed');
      expect(await readInvoiceStatus(a.kgId, a.invoiceId)).toBe('paid');
      expect(await readBalance(a.kgId, a.accountId)).toBe(30000);

      // kg_B completely unchanged — no cross-tenant settlement, bypass GUC did
      // not leak.
      expect(await readPaymentStatus(b.kgId, b.paymentId)).toBe('processing');
      expect(await readInvoiceStatus(b.kgId, b.invoiceId)).toBe('pending');
      expect(await readBalance(b.kgId, b.accountId)).toBe(0);
    });
  },
);
