import * as crypto from 'crypto';
import { AesGcmCryptoCipherAdapter } from '@/shared-kernel/infrastructure/adapters/aes-gcm-crypto-cipher.adapter';
import { KaspiMerchantSession } from '../../../domain/entities/kaspi-merchant-session.entity';
import {
  KaspiNotConnectedError,
  KaspiPhoneRequiredError,
  KaspiWebhookUnsupportedError,
} from '../../../domain/errors/kaspi-connect.errors';
import { PaymentProviderError } from '../../../domain/errors/payment-provider.error';
import { KaspiGlobalConfig } from '../../../domain/kaspi-global-config';
import { KaspiGlobalConfigService } from '../../../kaspi-global-config.service';
import { KaspiMerchantSessionRepository } from '../../persistence/kaspi-merchant-session.repository';
import { KaspiHttpClient } from './kaspi-http.client';
import { KaspiPaymentProvider } from './kaspi-payment-provider.adapter';

const KG_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const INVOICE_ID = '11111111-1111-1111-1111-111111111111';
const QRPAY_URL = 'https://kaspi.example/qrpay';

// 32-byte test key for the real AES-256-GCM cipher.
const TEST_KEY = Buffer.alloc(32, 7);

const CONFIG: KaspiGlobalConfig = {
  appVersion: '4.110.1',
  appBuild: '1076',
  platformVer: '18.5',
  model: 'iPhone',
  brand: 'Apple',
  uaNative: 'Kaspi%20Pay/1076 CFNetwork/3826.500.131 Darwin/24.5.0',
  uaBrowser: 'Mozilla/5.0',
  entranceUrl: 'https://kaspi.example/entrance',
  mtokenUrl: 'https://kaspi.example/mtoken',
  qrpayUrl: QRPAY_URL,
  updatedBy: null,
  updatedAt: new Date('2026-06-01T00:00:00.000Z'),
};

// ─── In-memory session repo fake ───────────────────────────────────────────

class FakeSessionRepo extends KaspiMerchantSessionRepository {
  private store = new Map<string, KaspiMerchantSession>();

  set(session: KaspiMerchantSession): void {
    this.store.set(session.kindergartenId, session);
  }

  findByKindergartenId(
    kindergartenId: string,
  ): Promise<KaspiMerchantSession | null> {
    return Promise.resolve(this.store.get(kindergartenId) ?? null);
  }

  findByKindergartenIdBypassRls(
    kindergartenId: string,
  ): Promise<KaspiMerchantSession | null> {
    return this.findByKindergartenId(kindergartenId);
  }

  save(session: KaspiMerchantSession): Promise<KaspiMerchantSession> {
    this.set(session);
    return Promise.resolve(session);
  }

  saveBypassRls(session: KaspiMerchantSession): Promise<KaspiMerchantSession> {
    this.set(session);
    return Promise.resolve(session);
  }
}

// ─── Mocked KaspiHttpClient (NEVER hits real Kaspi) ────────────────────────

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

class FakeHttpClient extends KaspiHttpClient {
  requests: RecordedRequest[] = [];
  nextResponse: { status: number; json: unknown } = { status: 200, json: {} };

  override request(
    method: 'GET' | 'POST',
    url: string,
    opts: { headers: Record<string, string>; body?: unknown },
  ): Promise<{ status: number; json: unknown; setCookie: string[] }> {
    this.requests.push({ method, url, headers: opts.headers, body: opts.body });
    return Promise.resolve({ ...this.nextResponse, setCookie: [] });
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildConfigService(): KaspiGlobalConfigService {
  return {
    getConfig: () => Promise.resolve(CONFIG),
  } as unknown as KaspiGlobalConfigService;
}

/**
 * Builds an active KaspiMerchantSession with credentials encrypted in the
 * EXACT K5 at-rest formats (vtoken = AES-GCM of raw secret Buffer;
 * deviceKeypair = AES-GCM of JSON `{privateKey, publicKey}` with pkcs8 DER b64).
 */
function buildActiveSession(
  cipher: AesGcmCryptoCipherAdapter,
  status: 'active' | 'expired' = 'active',
): KaspiMerchantSession {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  const devicePrivateKeyDerB64 = privateKey
    .export({ type: 'pkcs8', format: 'der' })
    .toString('base64');
  const devicePublicKeyDerB64 = publicKey
    .export({ type: 'spki', format: 'der' })
    .toString('base64');
  const deviceKeypairJson = JSON.stringify({
    privateKey: devicePrivateKeyDerB64,
    publicKey: devicePublicKeyDerB64,
  });
  const rawSecret = crypto.randomBytes(32);

  const now = new Date('2026-06-04T10:00:00.000Z');
  return KaspiMerchantSession.fromState({
    id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    kindergartenId: KG_ID,
    connectedByUserId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    status,
    cashierPhone: '77001234567',
    kaspiProfileId: '42',
    kaspiOrgId: '7',
    orgName: 'Test Kindergarten LLP',
    tokenSn: 'TOKEN-SN-123',
    vtokenSecretEnc: cipher.encrypt(rawSecret),
    deviceKeypairEnc: cipher.encryptString(deviceKeypairJson),
    ecdhKeypairEnc: cipher.encryptString(
      JSON.stringify({ privateKey: 'x', publicKey: 'y' }),
    ),
    deviceId: 'DEVICE-ID-1',
    installId: 'INSTALL-ID-1',
    pinHash: 'pinhash',
    lastCheckedAt: now,
    createdAt: now,
    updatedAt: now,
  });
}

function buildAdapter(): {
  adapter: KaspiPaymentProvider;
  repo: FakeSessionRepo;
  http: FakeHttpClient;
  cipher: AesGcmCryptoCipherAdapter;
} {
  const cipher = new AesGcmCryptoCipherAdapter(TEST_KEY);
  const repo = new FakeSessionRepo();
  const http = new FakeHttpClient();
  const adapter = new KaspiPaymentProvider(
    repo,
    cipher,
    http,
    buildConfigService(),
  );
  return { adapter, repo, http, cipher };
}

describe('KaspiPaymentProvider', () => {
  describe('createPayment', () => {
    it('returns the QrOperationId + deeplink on a successful remote/create', async () => {
      const { adapter, repo, http, cipher } = buildAdapter();
      repo.set(buildActiveSession(cipher));
      http.nextResponse = {
        status: 200,
        json: {
          Data: {
            QrOperationId: 987654,
            RecreateDeepLink: 'https://kaspi.kz/pay/987654',
          },
        },
      };

      const result = await adapter.createPayment({
        kindergartenId: KG_ID,
        invoiceId: INVOICE_ID,
        amountKzt: 50000,
        currency: 'KZT',
        returnUrl: 'https://app.shyraq.local/return',
        phoneNumber: '77001234567',
        idempotencyKey: 'idem-1',
      });

      expect(result).toEqual({
        providerPaymentId: '987654',
        status: 'initiated',
        deeplink: 'https://kaspi.kz/pay/987654',
      });

      const req = http.requests[0];
      expect(req.method).toBe('POST');
      expect(req.url).toBe(`${QRPAY_URL}/v01/remote/create`);
      expect(req.headers['Content-Type']).toBe('application/json');
      expect(req.headers['X-Sign']).toBeDefined();
      expect(req.body).toEqual({
        PhoneNumber: '77001234567',
        Amount: 50000,
        Comment: INVOICE_ID,
      });
    });

    it('rounds fractional tenge to an integer Amount', async () => {
      const { adapter, repo, http, cipher } = buildAdapter();
      repo.set(buildActiveSession(cipher));
      http.nextResponse = {
        status: 200,
        json: { Data: { QrOperationId: '1' } },
      };

      await adapter.createPayment({
        kindergartenId: KG_ID,
        invoiceId: INVOICE_ID,
        amountKzt: 50000.6,
        currency: 'KZT',
        returnUrl: 'https://app.shyraq.local/return',
        phoneNumber: '77001234567',
        idempotencyKey: 'idem-round',
      });

      expect((http.requests[0].body as { Amount: number }).Amount).toBe(50001);
    });

    it('omits deeplink when RecreateDeepLink is absent', async () => {
      const { adapter, repo, http, cipher } = buildAdapter();
      repo.set(buildActiveSession(cipher));
      http.nextResponse = {
        status: 200,
        json: { Data: { QrOperationId: '555' } },
      };

      const result = await adapter.createPayment({
        kindergartenId: KG_ID,
        invoiceId: INVOICE_ID,
        amountKzt: 1000,
        currency: 'KZT',
        returnUrl: 'https://app.shyraq.local/return',
        phoneNumber: '77001234567',
        idempotencyKey: 'idem-nodl',
      });

      expect(result.providerPaymentId).toBe('555');
      expect(result.deeplink).toBeUndefined();
    });

    it('throws KaspiPhoneRequiredError when no phoneNumber is supplied', async () => {
      const { adapter, repo, cipher } = buildAdapter();
      repo.set(buildActiveSession(cipher));

      await expect(
        adapter.createPayment({
          kindergartenId: KG_ID,
          invoiceId: INVOICE_ID,
          amountKzt: 1000,
          currency: 'KZT',
          returnUrl: 'https://app.shyraq.local/return',
          idempotencyKey: 'idem-nophone',
        }),
      ).rejects.toBeInstanceOf(KaspiPhoneRequiredError);
    });

    it('throws KaspiNotConnectedError when no session exists', async () => {
      const { adapter } = buildAdapter();

      await expect(
        adapter.createPayment({
          kindergartenId: KG_ID,
          invoiceId: INVOICE_ID,
          amountKzt: 1000,
          currency: 'KZT',
          returnUrl: 'https://app.shyraq.local/return',
          phoneNumber: '77001234567',
          idempotencyKey: 'idem-nosession',
        }),
      ).rejects.toBeInstanceOf(KaspiNotConnectedError);
    });

    it('throws KaspiNotConnectedError when the session is not active', async () => {
      const { adapter, repo, cipher } = buildAdapter();
      repo.set(buildActiveSession(cipher, 'expired'));

      await expect(
        adapter.createPayment({
          kindergartenId: KG_ID,
          invoiceId: INVOICE_ID,
          amountKzt: 1000,
          currency: 'KZT',
          returnUrl: 'https://app.shyraq.local/return',
          phoneNumber: '77001234567',
          idempotencyKey: 'idem-inactive',
        }),
      ).rejects.toBeInstanceOf(KaspiNotConnectedError);
    });

    it('throws PaymentProviderError on a non-2xx HTTP response (error envelope is not a success)', async () => {
      const { adapter, repo, http, cipher } = buildAdapter();
      repo.set(buildActiveSession(cipher));
      // Even with a QrOperationId present in the body, a 4xx/5xx must fail.
      http.nextResponse = {
        status: 500,
        json: { Data: { QrOperationId: '999' } },
      };

      await expect(
        adapter.createPayment({
          kindergartenId: KG_ID,
          invoiceId: INVOICE_ID,
          amountKzt: 1000,
          currency: 'KZT',
          returnUrl: 'https://app.shyraq.local/return',
          phoneNumber: '77001234567',
          idempotencyKey: 'idem-http500',
        }),
      ).rejects.toBeInstanceOf(PaymentProviderError);
    });

    it('throws PaymentProviderError when QrOperationId is missing from the response', async () => {
      const { adapter, repo, http, cipher } = buildAdapter();
      repo.set(buildActiveSession(cipher));
      http.nextResponse = {
        status: 200,
        json: { Data: { Status: 'SomeError' } },
      };

      await expect(
        adapter.createPayment({
          kindergartenId: KG_ID,
          invoiceId: INVOICE_ID,
          amountKzt: 1000,
          currency: 'KZT',
          returnUrl: 'https://app.shyraq.local/return',
          phoneNumber: '77001234567',
          idempotencyKey: 'idem-noqr',
        }),
      ).rejects.toBeInstanceOf(PaymentProviderError);
    });
  });

  describe('refund', () => {
    it('posts history-pos-return with integer ReturnAmount and DeviceInterface=Pos', async () => {
      const { adapter, repo, http, cipher } = buildAdapter();
      repo.set(buildActiveSession(cipher));
      http.nextResponse = {
        status: 200,
        json: { Data: { ReturnOperationId: 'RET-1', Status: 'Returned' } },
      };

      const result = await adapter.refund({
        kindergartenId: KG_ID,
        providerPaymentId: '987654',
        amountKzt: 50000.4,
        reason: 'parent_requested',
        idempotencyKey: 'refund:abc',
      });

      expect(result).toEqual({
        providerRefundId: 'RET-1',
        status: 'processed',
      });

      const req = http.requests[0];
      expect(req.method).toBe('POST');
      expect(req.url).toBe(`${QRPAY_URL}/v01/kaspi-qr/history-pos-return`);
      expect(req.headers['Content-Type']).toBe('application/json');
      expect(req.body).toEqual({
        QrOperationId: '987654',
        ReturnAmount: 50000,
        DeviceInterface: 'Pos',
      });
    });

    it('synthesizes a refund id when Kaspi omits one', async () => {
      const { adapter, repo, http, cipher } = buildAdapter();
      repo.set(buildActiveSession(cipher));
      http.nextResponse = {
        status: 200,
        json: { Data: { Status: 'Returned' } },
      };

      const result = await adapter.refund({
        kindergartenId: KG_ID,
        providerPaymentId: '987654',
        amountKzt: 1000,
        reason: 'r',
        idempotencyKey: 'refund:def',
      });

      expect(result.providerRefundId).toBe('kaspi_refund_987654');
      expect(result.status).toBe('processed');
    });

    it('throws PaymentProviderError when the return response carries no Data', async () => {
      const { adapter, repo, http, cipher } = buildAdapter();
      repo.set(buildActiveSession(cipher));
      // 2xx but no Data → the data==null guard fires.
      http.nextResponse = { status: 200, json: { error: 'bad' } };

      await expect(
        adapter.refund({
          kindergartenId: KG_ID,
          providerPaymentId: '987654',
          amountKzt: 1000,
          reason: 'r',
          idempotencyKey: 'refund:ghi',
        }),
      ).rejects.toBeInstanceOf(PaymentProviderError);
    });

    it('throws PaymentProviderError on a non-2xx HTTP response (does not relay as processed)', async () => {
      const { adapter, repo, http, cipher } = buildAdapter();
      repo.set(buildActiveSession(cipher));
      // 4xx even with a Data envelope present must not be treated as a refund.
      http.nextResponse = {
        status: 400,
        json: { Data: { ReturnOperationId: 'RET-X' } },
      };

      await expect(
        adapter.refund({
          kindergartenId: KG_ID,
          providerPaymentId: '987654',
          amountKzt: 1000,
          reason: 'r',
          idempotencyKey: 'refund:http400',
        }),
      ).rejects.toBeInstanceOf(PaymentProviderError);
    });
  });

  describe('verifyWebhook', () => {
    it('throws KaspiWebhookUnsupportedError (Kaspi has no inbound callback)', async () => {
      const { adapter } = buildAdapter();

      await expect(
        adapter.verifyWebhook({ headers: {}, body: {} }),
      ).rejects.toBeInstanceOf(KaspiWebhookUnsupportedError);
    });
  });
});
