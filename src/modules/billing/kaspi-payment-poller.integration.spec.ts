/**
 * B24 / K9 — Kaspi status-poller settlement integration spec.
 *
 * Drives ONE real end-to-end settlement of a `kaspi_pay` payment through the
 * live `KaspiPaymentStatusPollerService` against real PostgreSQL + Redis. The
 * ONLY seam is the Kaspi HTTP boundary (`KaspiHttpClient`), overridden with a
 * URL-routing fake so `remote/details` returns `Processed`. Everything else —
 * RLS, the cross-tenant payment load, the advisory-lock + conditional-UPDATE
 * settlement, the payment_account credit, the invoice flip — runs for real.
 *
 * Self-skips when `INTEGRATION_DB !== '1'` so `npm test` stays green on
 * machines without a configured tenant DB + Redis. Run with:
 *
 *   $env:DATABASE_PORT='55432'; $env:DATABASE_USERNAME='shyraq_app'
 *   $env:DATABASE_PASSWORD='shyraq_app'; $env:INTEGRATION_DB='1'
 *   npm test -- --testPathPattern='kaspi-payment-poller.integration'
 *
 * (requires docker `postgres` + a dev Redis on REDIS_PORT.)
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
import {
  KaspiFetch,
  KaspiHttpClient,
  KaspiHttpResponse,
} from './infrastructure/payment-provider/kaspi/kaspi-http.client';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

// 64-hex AES-256 key — set BEFORE the AppModule factory wires CryptoCipherPort
// so the test gets the real AES-GCM adapter (not the unconfigured fallback).
const TEST_KASPI_KEY_HEX = 'a'.repeat(64);

/**
 * URL-routing fake KaspiHttpClient. Routes by URL substring and returns canned
 * `{status, json, setCookie}`. We extend the real class so the DI token (the
 * class itself) is satisfied; `request` is fully overridden — no network.
 */
class FakeKaspiHttpClient extends KaspiHttpClient {
  detailsStatus: number;
  detailsJson: unknown;
  readonly calls: Array<{ method: string; url: string }> = [];

  constructor(
    detailsStatus = 200,
    detailsJson: unknown = { Data: { Status: 'Processed' } },
  ) {
    super(undefined as unknown as KaspiFetch);
    this.detailsStatus = detailsStatus;
    this.detailsJson = detailsJson;
  }

  override request(
    method: 'GET' | 'POST',
    url: string,
  ): Promise<KaspiHttpResponse> {
    this.calls.push({ method, url });
    if (url.includes('/remote/details')) {
      return Promise.resolve({
        status: this.detailsStatus,
        json: this.detailsJson,
        setCookie: [],
      });
    }
    // No other endpoint is exercised by getPaymentStatus.
    return Promise.resolve({ status: 200, json: { Data: {} }, setCookie: [] });
  }
}

/**
 * Re-seed the `kaspi_global_config` singleton (id=1) if absent. The migration
 * seeds it, but cross-suite TRUNCATE can wipe it; `KaspiGlobalConfigService`
 * throws `kaspi_global_config_missing` without it. Idempotent (ON CONFLICT).
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

/** Generate a fresh EC P-256 keypair as base64 pkcs8/spki DER (mirrors doFinish). */
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

describeIntegration(
  'KaspiPaymentStatusPollerService — settlement (integration)',
  () => {
    jest.setTimeout(120_000);

    let app: INestApplication;
    let dataSource: DataSource;
    let poller: KaspiPaymentStatusPollerService;
    let cipher: CryptoCipherPort;
    let http: FakeKaspiHttpClient;

    beforeAll(async () => {
      process.env.KASPI_ENCRYPTION_KEY = TEST_KASPI_KEY_HEX;
      http = new FakeKaspiHttpClient();

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(SmsPort)
        .useClass(MockSmsAdapter)
        .overrideProvider(KaspiHttpClient)
        .useValue(http)
        .compile();

      app = moduleRef.createNestApplication({ bufferLogs: true });
      await app.init();

      dataSource = app.get(DataSource);
      poller = app.get(KaspiPaymentStatusPollerService);
      cipher = app.get(CryptoCipherPort);

      // The kaspi_global_config singleton is migration-seeded, but other gated
      // suites' TRUNCATE can wipe it between runs. getPaymentStatus →
      // getConfig() throws `kaspi_global_config_missing` when it's absent, so
      // re-seed it (idempotent) before any poll.
      await ensureKaspiGlobalConfig(dataSource);
    });

    afterAll(async () => {
      if (app) await app.close();
      delete process.env.KASPI_ENCRYPTION_KEY;
    });

    interface Seed {
      kgId: string;
      userId: string;
      childId: string;
      accountId: string;
      invoiceId: string;
      paymentId: string;
      qrOp: string;
      cleanup: () => Promise<void>;
    }

    /** Seed kg + user + child + payment_account + invoice + active session + payment. */
    async function seedKaspiProcessing(amount: number): Promise<Seed> {
      const kgId = randomUUID();
      const userId = randomUUID();
      const childId = randomUUID();
      const accountId = randomUUID();
      const invoiceId = randomUUID();
      const paymentId = randomUUID();
      const sessionId = randomUUID();
      const qrOp = `qr_${randomUUID()}`;
      const slug = `kaspi-poll-${kgId.slice(0, 8)}`;
      const phone = `+7700${kgId.replace(/-/g, '').slice(0, 7)}`;

      const deviceKeypairEnc = cipher.encryptString(
        generateDeviceKeypairJson(),
      );
      const vtokenSecretEnc = cipher.encryptString(''); // empty → MAC '000000'

      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(
          `INSERT INTO kindergartens (id, name, slug, is_active) VALUES ($1, 'Kaspi Poll KG', $2, true)`,
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
          `INSERT INTO payment_accounts (id, kindergarten_id, child_id, balance)
         VALUES ($1, $2, $3, 0)`,
          [accountId, kgId, childId],
        );
        await m.query(
          `INSERT INTO invoices
           (id, kindergarten_id, child_id, payment_account_id, invoice_type,
            period_start, period_end, amount_due, amount_after_discount, status, due_date)
         VALUES ($1, $2, $3, $4, 'monthly', '2026-06-01', '2026-06-30',
                 $5, $5, 'pending', '2026-06-10')`,
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

      const cleanup = async () => {
        await dataSource.transaction(async (m) => {
          await m.query(`SET LOCAL app.bypass_rls = 'true'`);
          await m.query(`DELETE FROM payments WHERE kindergarten_id = $1`, [
            kgId,
          ]);
          await m.query(
            `DELETE FROM kaspi_merchant_session WHERE kindergarten_id = $1`,
            [kgId],
          );
          await m.query(`DELETE FROM invoices WHERE kindergarten_id = $1`, [
            kgId,
          ]);
          await m.query(
            `DELETE FROM payment_accounts WHERE kindergarten_id = $1`,
            [kgId],
          );
          await m.query(`DELETE FROM children WHERE kindergarten_id = $1`, [
            kgId,
          ]);
          await m.query(`DELETE FROM users WHERE id = $1`, [userId]);
          await m.query(`DELETE FROM kindergartens WHERE id = $1`, [kgId]);
        });
      };

      return {
        kgId,
        userId,
        childId,
        accountId,
        invoiceId,
        paymentId,
        qrOp,
        cleanup,
      };
    }

    async function readPayment(
      kgId: string,
      paymentId: string,
    ): Promise<{ status: string; paid_at: string | null }> {
      return dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        const rows = (await m.query(
          `SELECT status, paid_at FROM payments WHERE id = $1 AND kindergarten_id = $2`,
          [paymentId, kgId],
        )) as Array<{ status: string; paid_at: string | null }>;
        return rows[0];
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

    it('settles a processing kaspi_pay payment when remote/details reports Processed', async () => {
      const s = await seedKaspiProcessing(45000);
      try {
        const result = await poller.pollOnce(s.kgId, s.paymentId);
        expect(result.outcome).toBe('settled');

        const payment = await readPayment(s.kgId, s.paymentId);
        expect(payment.status).toBe('completed');
        expect(payment.paid_at).not.toBeNull();

        expect(await readInvoiceStatus(s.kgId, s.invoiceId)).toBe('paid');
        expect(await readBalance(s.kgId, s.accountId)).toBe(45000);
      } finally {
        await s.cleanup();
      }
    });

    it('is idempotent — a second pollOnce on an already-completed payment is a no-op (no double credit)', async () => {
      const s = await seedKaspiProcessing(45000);
      try {
        const first = await poller.pollOnce(s.kgId, s.paymentId);
        expect(first.outcome).toBe('settled');
        const balanceAfterFirst = await readBalance(s.kgId, s.accountId);
        expect(balanceAfterFirst).toBe(45000);

        // Second tick: the payment is now terminal (`completed`) so the poller
        // short-circuits with `stop` BEFORE calling Kaspi or settling again.
        const second = await poller.pollOnce(s.kgId, s.paymentId);
        expect(second.outcome).toBe('stop');

        // Balance unchanged — no second credit.
        expect(await readBalance(s.kgId, s.accountId)).toBe(45000);
        expect(await readInvoiceStatus(s.kgId, s.invoiceId)).toBe('paid');
      } finally {
        await s.cleanup();
      }
    });
  },
);
