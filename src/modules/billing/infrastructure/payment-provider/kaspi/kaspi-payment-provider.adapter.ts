import * as crypto from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { CryptoCipherPort } from '@/shared-kernel/application/ports/crypto-cipher.port';
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
import {
  CreatePaymentInput,
  CreatePaymentResult,
  PaymentProviderPort,
  RefundInput,
  RefundResult,
  VerifyWebhookInput,
  VerifyWebhookResult,
} from '../payment-provider.port';
import { KaspiHttpClient } from './kaspi-http.client';
import {
  ParsedRemoteDetails,
  parseRemoteDetails,
} from './kaspi-remote-details';
import {
  KaspiAppConfig,
  KaspiDeviceIdentity,
  KaspiSession,
  signedQrPayHeaders,
} from './kaspi-signed-headers';

// ─── Kaspi constants (decided — not stored in config) ──────────────────────
// `platform` is the iOS header/cookie value; `locale` is the fixed 'ru-RU'.
// Mirrors `KaspiConnectService` (K5) which inlines the same two constants.
const KASPI_PLATFORM = 'iOS';
const KASPI_LOCALE = 'ru-RU';

/**
 * KaspiPaymentProvider — the `PaymentProviderPort` adapter for
 * `PAYMENT_PROVIDER=kaspi` (alias `kaspi_pay`). B24 / K6.
 *
 * A faithful port of `kaspi_pay_test/src/routes/invoice.js#create` +
 * `refund.js#create`, adapted to the multi-tenant backend:
 *
 *   - The adapter is a SINGLETON, but credentials are PER-TENANT. Each call
 *     resolves the kindergarten's `kaspi_merchant_session` at call time
 *     (`createPayment`/`refund` both receive `kindergartenId` on their input),
 *     decrypts the at-rest creds just-in-time, builds the signed `qrpay`
 *     headers, and calls the live Kaspi API.
 *   - Decryption mirrors K5's at-rest formats EXACTLY:
 *       · `vtokenSecretEnc`   → AES-GCM blob of the raw ECDH-secret Buffer
 *                               (the vtoken MAC key) → `KaspiSession.decryptedSecret`.
 *       · `deviceKeypairEnc`  → AES-GCM blob of JSON `{privateKey, publicKey}`
 *                               where `privateKey` is the device ECDSA pkcs8 DER
 *                               (base64) → `KaspiDeviceIdentity.privateKey`.
 *   - `verifyWebhook` is UNSUPPORTED: Kaspi has no inbound callback. Settlement
 *     is driven by the K8 BullMQ poller. The method throws
 *     `KaspiWebhookUnsupportedError` (→ 501).
 *
 * Secrets hygiene: tokenSN, vtoken secret, device private key, and full phone
 * numbers are NEVER logged. No request-body logging here.
 */
@Injectable()
export class KaspiPaymentProvider extends PaymentProviderPort {
  private readonly logger = new Logger('KaspiPaymentProvider');

  constructor(
    private readonly sessions: KaspiMerchantSessionRepository,
    private readonly cipher: CryptoCipherPort,
    private readonly http: KaspiHttpClient,
    private readonly config: KaspiGlobalConfigService,
  ) {
    super();
  }

  // ── createPayment — qrpay remote/create ──────────────────────────────────

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const phone = input.phoneNumber?.trim();
    if (!phone) {
      // Adapter-level guard (the clean 400 lives in the K7 DTO). PaymentService
      // catches this and wraps it in PaymentProviderError → 502 today; once K7
      // ships, the DTO rejects before we are reached.
      throw new KaspiPhoneRequiredError();
    }

    const { session, cfg } = await this.resolveActiveSession(
      input.kindergartenId,
    );
    const device = this.deviceIdentity(session);
    const kaspiSession = this.kaspiSession(session);

    const url = `${cfg.qrpayUrl}/v01/remote/create`;
    // Content-Type contract (load-bearing, per invoice.js:54): remote/create is
    // a POST with a JSON body → 'application/json'. NOT part of the X-SH signing
    // list, so it does not affect X-Sign. Do NOT send text/plain here.
    const headers = {
      ...signedQrPayHeaders(url, kaspiSession, device, this.appConfig(cfg)),
      'Content-Type': 'application/json',
    };

    // Amount MUST be integer tenge — Kaspi rejects fractional tenge.
    const amount = Math.round(input.amountKzt);
    // Comment: short, non-PII human label. The invoiceId is a UUID (no secret).
    const comment = input.invoiceId;

    const { status, json } = await this.http.request('POST', url, {
      headers,
      body: { PhoneNumber: phone, Amount: amount, Comment: comment },
    });

    if (status < 200 || status >= 300) {
      // KaspiHttpClient does NOT throw on non-2xx — gate here so an error
      // envelope is never mistaken for an initiated payment. Body not logged.
      throw new PaymentProviderError(
        'kaspi_pay',
        `kaspi_create_http_${status}`,
      );
    }

    const data = this.extractData(json);
    const qrOperationId = data?.['QrOperationId'];
    if (qrOperationId == null) {
      // TODO(kaspi-protocol): a `session_expired` envelope here must trigger a
      // refresh via the K8 poller `/refresh` before retrying. Out of K6 scope —
      // K6 treats any missing QrOperationId as a hard failure so PaymentService
      // marks the payment failed and surfaces 502.
      this.logger.warn(
        `Kaspi remote/create returned no QrOperationId for kg=${input.kindergartenId} invoice=${input.invoiceId}`,
      );
      throw new PaymentProviderError(
        'kaspi_pay',
        'kaspi_create_no_qr_operation_id',
      );
    }

    const recreateDeepLink = data?.['RecreateDeepLink'];
    const deeplink =
      typeof recreateDeepLink === 'string' && recreateDeepLink !== ''
        ? recreateDeepLink
        : undefined;

    return {
      providerPaymentId: String(qrOperationId),
      status: 'initiated',
      deeplink,
    };
  }

  // ── refund — qrpay kaspi-qr/history-pos-return ───────────────────────────

  async refund(input: RefundInput): Promise<RefundResult> {
    const { session, cfg } = await this.resolveActiveSession(
      input.kindergartenId,
    );
    const device = this.deviceIdentity(session);
    const kaspiSession = this.kaspiSession(session);

    const url = `${cfg.qrpayUrl}/v01/kaspi-qr/history-pos-return`;
    // POST with a JSON body → 'application/json' (mirrors invoice.js cancel/
    // history + refund.js).
    const headers = {
      ...signedQrPayHeaders(url, kaspiSession, device, this.appConfig(cfg)),
      'Content-Type': 'application/json',
    };

    const returnAmount = Math.round(input.amountKzt);

    const { status, json } = await this.http.request('POST', url, {
      headers,
      body: {
        QrOperationId: input.providerPaymentId,
        ReturnAmount: returnAmount,
        DeviceInterface: 'Pos',
      },
    });

    if (status < 200 || status >= 300) {
      // Gate on HTTP status — non-2xx must not be relayed as a processed
      // refund. Body not logged.
      throw new PaymentProviderError(
        'kaspi_pay',
        `kaspi_refund_http_${status}`,
      );
    }

    const data = this.extractData(json);
    // TODO(kaspi-protocol): the reference does not branch on the return
    // response body — it relays it verbatim. We treat presence of `Data` as
    // success and synthesize a refund id when Kaspi omits an explicit one.
    if (data == null) {
      this.logger.warn(
        `Kaspi history-pos-return returned no Data for kg=${input.kindergartenId} op=${input.providerPaymentId}`,
      );
      throw new PaymentProviderError('kaspi_pay', 'kaspi_refund_failed');
    }

    // Prefer a Kaspi-supplied id; fall back to a synthesized deterministic id.
    const providerRefundId =
      this.firstString(data, ['ReturnOperationId', 'QrOperationId', 'Id']) ??
      `kaspi_refund_${input.providerPaymentId}`;

    return { providerRefundId, status: 'processed' };
  }

  // ── getPaymentStatus — qrpay remote/details (K8 poller) ──────────────────

  /**
   * Polls `remote/details?operationId=<QrOperationId>` for a single payment and
   * returns the parsed status envelope. Kaspi-specific (NOT on the
   * provider-agnostic `PaymentProviderPort`) — only the K8 poller calls it.
   *
   * The session is resolved CROSS-TENANT via `findByKindergartenIdBypassRls`
   * because the poller runs outside any HTTP/RLS context (no ambient tenant
   * EntityManager). No DB transaction is opened around the HTTP call.
   *
   * The same full URL string (including the query) is passed to BOTH
   * `signedQrPayHeaders` and the GET — X-Sign signs over `url`, so a mismatch
   * would break the signature. The URL is therefore built once.
   *
   * Secrets hygiene: tokenSN, vtoken secret, device key, phone, and the raw
   * response body are NEVER logged here.
   */
  async getPaymentStatus(input: {
    kindergartenId: string;
    providerPaymentId: string;
  }): Promise<ParsedRemoteDetails> {
    const session = await this.sessions.findByKindergartenIdBypassRls(
      input.kindergartenId,
    );
    if (!session || !session.isActive()) {
      throw new KaspiNotConnectedError();
    }
    const cfg = await this.config.getConfig();
    const device = this.deviceIdentity(session);
    const kaspiSession = this.kaspiSession(session);

    // Build the signed URL ONCE — X-Sign signs over this exact string, so the
    // value handed to signedQrPayHeaders MUST equal the one passed to the GET.
    const url =
      `${cfg.qrpayUrl}/v01/remote/details` +
      `?operationId=${encodeURIComponent(input.providerPaymentId)}`;
    const headers = signedQrPayHeaders(
      url,
      kaspiSession,
      device,
      this.appConfig(cfg),
    );

    // GET — no body. KaspiHttpClient does not throw on non-2xx; the parser
    // interprets 401/403 as session_expired.
    const { status, json } = await this.http.request('GET', url, { headers });

    return parseRemoteDetails(status, json);
  }

  // ── verifyWebhook — UNSUPPORTED (settlement is via the K8 poller) ─────────

  verifyWebhook(_input: VerifyWebhookInput): Promise<VerifyWebhookResult> {
    // Kaspi has no inbound payment callback. See docs/endpoints.md §4.5/§4.7.
    return Promise.reject(new KaspiWebhookUnsupportedError());
  }

  // ── per-tenant resolution + decryption ───────────────────────────────────

  /**
   * Loads the kindergarten's merchant session (must be `active`) and the global
   * Kaspi config. Throws `KaspiNotConnectedError` (→ 404) when no session
   * exists or the session is not active — the same error K5 uses for the
   * disconnected case.
   */
  private async resolveActiveSession(
    kindergartenId: string,
  ): Promise<{ session: KaspiMerchantSession; cfg: KaspiGlobalConfig }> {
    const session = await this.sessions.findByKindergartenId(kindergartenId);
    if (!session || !session.isActive()) {
      throw new KaspiNotConnectedError();
    }
    const cfg = await this.config.getConfig();
    return { session, cfg };
  }

  /** Decrypts the device ECDSA private key from `deviceKeypairEnc` (K5 format). */
  private deviceIdentity(session: KaspiMerchantSession): KaspiDeviceIdentity {
    if (!session.deviceKeypairEnc || !session.deviceId || !session.installId) {
      // An active session is always fully credentialed (K5 activate()), but
      // guard defensively rather than throw a raw decryption error.
      throw new KaspiNotConnectedError();
    }
    const keypair = JSON.parse(
      this.cipher.decryptString(session.deviceKeypairEnc),
    ) as { privateKey: string };
    const privateKey = crypto.createPrivateKey({
      key: Buffer.from(keypair.privateKey, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
    return {
      deviceId: session.deviceId,
      installId: session.installId,
      privateKey,
    };
  }

  /**
   * Decrypts the raw ECDH shared secret (vtoken MAC key) from `vtokenSecretEnc`.
   * K5 stores an AES-GCM blob of the raw secret Buffer (or of an empty string
   * when Kaspi omitted its x509). A zero-length decrypted buffer maps to a null
   * secret so `computeTokenSnMac` falls back to '000000', mirroring K5.
   */
  private kaspiSession(session: KaspiMerchantSession): KaspiSession {
    if (!session.tokenSn) {
      throw new KaspiNotConnectedError();
    }
    let decryptedSecret: Buffer | null = null;
    if (session.vtokenSecretEnc) {
      const buf = this.cipher.decrypt(session.vtokenSecretEnc);
      decryptedSecret = buf.length > 0 ? buf : null;
    }
    return {
      tokenSN: session.tokenSn,
      decryptedSecret,
      profileId: session.kaspiProfileId,
    };
  }

  private appConfig(cfg: KaspiGlobalConfig): KaspiAppConfig {
    return {
      version: cfg.appVersion,
      build: cfg.appBuild,
      platform: KASPI_PLATFORM,
      platformVer: cfg.platformVer,
      locale: KASPI_LOCALE,
      uaNative: cfg.uaNative,
    };
  }

  // ── response helpers ─────────────────────────────────────────────────────

  private extractData(json: unknown): Record<string, unknown> | null {
    const body = json as Record<string, unknown> | null;
    const data = body?.['Data'];
    return data != null && typeof data === 'object'
      ? (data as Record<string, unknown>)
      : null;
  }

  private firstString(
    data: Record<string, unknown>,
    keys: string[],
  ): string | undefined {
    for (const key of keys) {
      const v = data[key];
      if (typeof v === 'string' && v !== '') return v;
      if (typeof v === 'number') return String(v);
    }
    return undefined;
  }
}
