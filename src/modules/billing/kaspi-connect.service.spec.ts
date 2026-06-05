import * as crypto from 'node:crypto';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { CryptoCipherPort } from '@/shared-kernel/application/ports/crypto-cipher.port';
import { KaspiGlobalConfig } from './domain/kaspi-global-config';
import { KaspiGlobalConfigRepository } from './infrastructure/persistence/kaspi-global-config.repository';
import { KaspiGlobalConfigService } from './kaspi-global-config.service';
import { KaspiConnectService } from './kaspi-connect.service';
import { KaspiMerchantSession } from './domain/entities/kaspi-merchant-session.entity';
import {
  KaspiAlreadyConnectedError,
  KaspiAppVersionOutdatedError,
  KaspiFinishFailedError,
  KaspiInvalidPhoneError,
  KaspiNotConnectedError,
  KaspiOtpInvalidError,
  KaspiUnknownProcessError,
} from './domain/errors/kaspi-connect.errors';
import { KaspiMerchantSessionRepository } from './infrastructure/persistence/kaspi-merchant-session.repository';
import {
  KaspiOnboardingState,
  KaspiOnboardingStorePort,
} from './infrastructure/onboarding/kaspi-onboarding-store.port';
import {
  KaspiHttpResponse,
  KaspiRequestOptions,
} from './infrastructure/payment-provider/kaspi/kaspi-http.client';

// ─── Fixtures ──────────────────────────────────────────────────────────────

const BASE_CONFIG: KaspiGlobalConfig = {
  appVersion: '4.110.1',
  appBuild: '1076',
  platformVer: '18.5',
  model: 'iPhone17,3',
  brand: 'Apple',
  uaNative: 'Kaspi%20Pay/1076 CFNetwork/3826.500.131 Darwin/24.5.0',
  uaBrowser:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  entranceUrl: 'https://entrance-pay.kaspi.kz',
  mtokenUrl: 'https://mtoken.kaspi.kz',
  qrpayUrl: 'https://qrpay.kaspi.kz',
  updatedBy: null,
  updatedAt: new Date('2026-05-01T00:00:00.000Z'),
};

const KG = 'kg-1111-2222';
const USER = 'user-9999';

// ─── In-memory fakes ─────────────────────────────────────────────────────────

class FakeConfigRepo extends KaspiGlobalConfigRepository {
  get(): Promise<KaspiGlobalConfig> {
    return Promise.resolve({ ...BASE_CONFIG });
  }
  update(): Promise<KaspiGlobalConfig> {
    return Promise.resolve({ ...BASE_CONFIG });
  }
}

class FakeOnboardingStore extends KaspiOnboardingStorePort {
  private readonly map = new Map<string, KaspiOnboardingState>();
  put(state: KaspiOnboardingState): Promise<void> {
    this.map.set(state.processId, { ...state });
    return Promise.resolve();
  }
  get(processId: string): Promise<KaspiOnboardingState | null> {
    const s = this.map.get(processId);
    return Promise.resolve(s ? { ...s } : null);
  }
  delete(processId: string): Promise<void> {
    this.map.delete(processId);
    return Promise.resolve();
  }
  has(processId: string): boolean {
    return this.map.has(processId);
  }
}

class FakeSessionRepo extends KaspiMerchantSessionRepository {
  private rows = new Map<string, KaspiMerchantSession>();
  seed(session: KaspiMerchantSession): void {
    this.rows.set(session.kindergartenId, session);
  }
  findByKindergartenId(kg: string): Promise<KaspiMerchantSession | null> {
    const s = this.rows.get(kg);
    return Promise.resolve(
      s ? KaspiMerchantSession.fromState(s.toState()) : null,
    );
  }
  findByKindergartenIdBypassRls(
    kg: string,
  ): Promise<KaspiMerchantSession | null> {
    return this.findByKindergartenId(kg);
  }
  save(session: KaspiMerchantSession): Promise<KaspiMerchantSession> {
    this.rows.set(session.kindergartenId, session);
    return Promise.resolve(session);
  }
  saveBypassRls(session: KaspiMerchantSession): Promise<KaspiMerchantSession> {
    this.rows.set(session.kindergartenId, session);
    return Promise.resolve(session);
  }
  touchLastCheckedAtBypassRls(): Promise<void> {
    return Promise.resolve();
  }
  current(kg: string): KaspiMerchantSession | undefined {
    return this.rows.get(kg);
  }
}

/**
 * Reversible "cipher" for tests — NOT real crypto, just a tag wrapper so we can
 * assert that values were encrypted (tagged) and round-trip cleanly. The real
 * AES-GCM adapter is exercised by its own K1 spec.
 */
class FakeCipher extends CryptoCipherPort {
  encrypt(plaintext: Buffer): string {
    return 'ENC:' + plaintext.toString('base64');
  }
  decrypt(blob: string): Buffer {
    return Buffer.from(blob.replace(/^ENC:/, ''), 'base64');
  }
  encryptString(plaintext: string): string {
    return 'ENC:' + Buffer.from(plaintext, 'utf8').toString('base64');
  }
  decryptString(blob: string): string {
    return Buffer.from(blob.replace(/^ENC:/, ''), 'base64').toString('utf8');
  }
}

class FixedClock extends ClockPort {
  now(): Date {
    return new Date('2026-06-04T10:00:00.000Z');
  }
}

/** Scripted, mocked KaspiHttpClient — NEVER hits real Kaspi / sends real SMS. */
class MockHttp {
  public calls: Array<{ url: string; opts: KaspiRequestOptions }> = [];
  private queue: KaspiHttpResponse[] = [];

  enqueue(res: Partial<KaspiHttpResponse>): void {
    this.queue.push({ status: 200, json: null, setCookie: [], ...res });
  }

  request(
    _method: 'GET' | 'POST',
    url: string,
    opts: KaspiRequestOptions,
  ): Promise<KaspiHttpResponse> {
    this.calls.push({ url, opts });
    const next = this.queue.shift();
    if (!next) throw new Error(`unexpected http call to ${url}`);
    return Promise.resolve(next);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildService(http: MockHttp): {
  service: KaspiConnectService;
  store: FakeOnboardingStore;
  repo: FakeSessionRepo;
} {
  const configSvc = new KaspiGlobalConfigService(new FakeConfigRepo());
  const store = new FakeOnboardingStore();
  const repo = new FakeSessionRepo();
  const service = new KaspiConnectService(
    configSvc,
    http as never,
    store,
    repo,
    new FakeCipher(),
    new FixedClock(),
  );
  return { service, store, repo };
}

/** A server-side ECDH keypair so finish's deriveEcdhSecret has a valid x509. */
function serverEcdhX509(): string {
  const { publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  return publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
}

async function driveToFinish(
  http: MockHttp,
  service: KaspiConnectService,
): Promise<void> {
  // init
  http.enqueue({
    json: { meta: { pId: 'PID-1' } },
    setCookie: ['user_token=UT1; Path=/'],
  });
  await service.init(KG, USER);
  // send-phone
  http.enqueue({
    json: { view: { code: 'EnterOtp' } },
    setCookie: ['user_token=UT2; Path=/'],
  });
  await service.sendPhone(KG, 'PID-1', '77011234567');
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('KaspiConnectService', () => {
  describe('init', () => {
    it('returns a process_id and stores in-flight state (no SMS)', async () => {
      const http = new MockHttp();
      const { service, store } = buildService(http);
      http.enqueue({
        json: { meta: { pId: 'PID-1' } },
        setCookie: ['user_token=UT1; Path=/'],
      });

      const { processId } = await service.init(KG, USER);

      expect(processId).toBe('PID-1');
      expect(store.has('PID-1')).toBe(true);
      const url = http.calls[0].url;
      expect(url).toBe('https://entrance-pay.kaspi.kz/api/v1/entrance/step');
    });

    it('throws kaspi_app_version_outdated when Kaspi gates the build', async () => {
      const http = new MockHttp();
      const { service } = buildService(http);
      http.enqueue({
        json: {
          view: { onOpenAlarm: { error: { code: 'OldVersionToUpdate' } } },
        },
      });

      await expect(service.init(KG, USER)).rejects.toBeInstanceOf(
        KaspiAppVersionOutdatedError,
      );
    });

    it('throws kaspi_already_connected when an active session exists', async () => {
      const http = new MockHttp();
      const { service, repo } = buildService(http);
      repo.seed(activeSession());

      await expect(service.init(KG, USER)).rejects.toBeInstanceOf(
        KaspiAlreadyConnectedError,
      );
      // No Kaspi call should have been made.
      expect(http.calls).toHaveLength(0);
    });
  });

  describe('send-phone', () => {
    it('reports sms_sent=true on EnterOtp view and rotates the user_token', async () => {
      const http = new MockHttp();
      const { service, store } = buildService(http);
      http.enqueue({
        json: { meta: { pId: 'PID-1' } },
        setCookie: ['user_token=UT1'],
      });
      await service.init(KG, USER);

      http.enqueue({
        json: { view: { code: 'EnterOtp' } },
        setCookie: ['user_token=UT2; Path=/'],
      });
      const res = await service.sendPhone(KG, 'PID-1', '77011234567');

      expect(res.smsSent).toBe(true);
      const state = await store.get('PID-1');
      // Stored + sent as the 10-digit NATIONAL number (country code stripped).
      expect(state?.phoneNumber).toBe('7011234567');
      expect(state?.userToken).toBe('UT2');
      // The wire value to Kaspi is the normalized 10-digit national number —
      // the 11-digit form is what Kaspi rejects as "not any operator".
      const sendBody = http.calls[1].opts.body as {
        data: { phoneNumber: string };
      };
      expect(sendBody.data.phoneNumber).toBe('7011234567');
    });

    it('normalizes assorted KZ phone shapes to the 10-digit national number', async () => {
      for (const input of [
        '7011234567', // bare 10-digit national
        '77011234567', // 11-digit with country code
        '87011234567', // 8-prefixed
        '+77011234567', // E.164
        '+7 (701) 123-45-67', // formatted
      ]) {
        const http = new MockHttp();
        const { service } = buildService(http);
        http.enqueue({
          json: { meta: { pId: 'PID-1' } },
          setCookie: ['user_token=UT1'],
        });
        await service.init(KG, USER);
        http.enqueue({
          json: { view: { code: 'EnterOtp' } },
          setCookie: ['user_token=UT2'],
        });

        await service.sendPhone(KG, 'PID-1', input);

        const body = http.calls[1].opts.body as {
          data: { phoneNumber: string };
        };
        expect(body.data.phoneNumber).toBe('7011234567');
      }
    });

    it('throws kaspi_invalid_phone when the number cannot reduce to 10 digits', async () => {
      const http = new MockHttp();
      const { service } = buildService(http);
      http.enqueue({
        json: { meta: { pId: 'PID-1' } },
        setCookie: ['user_token=UT1'],
      });
      await service.init(KG, USER);

      await expect(
        service.sendPhone(KG, 'PID-1', '12345'),
      ).rejects.toBeInstanceOf(KaspiInvalidPhoneError);
      // No Kaspi entrance call for the phone step — rejected before the wire.
      expect(http.calls).toHaveLength(1);
    });

    it('throws kaspi_app_version_outdated when Kaspi gates the build on send-phone', async () => {
      const http = new MockHttp();
      const { service, store } = buildService(http);
      http.enqueue({
        json: { meta: { pId: 'PID-1' } },
        setCookie: ['user_token=UT1'],
      });
      await service.init(KG, USER);

      http.enqueue({
        json: {
          view: { onOpenAlarm: { error: { code: 'OldVersionToUpdate' } } },
        },
        setCookie: ['user_token=UT2'],
      });
      await expect(
        service.sendPhone(KG, 'PID-1', '77011234567'),
      ).rejects.toBeInstanceOf(KaspiAppVersionOutdatedError);

      // State not advanced — phone was not captured.
      const state = await store.get('PID-1');
      expect(state?.phoneNumber).toBeNull();
    });

    it('throws send_phone_failed when the view is not EnterOtp (failure is an error, not sms_sent:false)', async () => {
      const http = new MockHttp();
      const { service, store } = buildService(http);
      http.enqueue({
        json: { meta: { pId: 'PID-1' } },
        setCookie: ['user_token=UT1'],
      });
      await service.init(KG, USER);

      http.enqueue({
        json: { view: { code: 'SomethingElse' } },
        setCookie: ['user_token=UT2'],
      });
      await expect(
        service.sendPhone(KG, 'PID-1', '77011234567'),
      ).rejects.toBeInstanceOf(KaspiFinishFailedError);

      // State not persisted (no rotated token / phone) when the SMS did not send.
      const state = await store.get('PID-1');
      expect(state?.phoneNumber).toBeNull();
      expect(state?.userToken).toBe('UT1');
    });

    it('throws kaspi_unknown_process for an unknown process_id', async () => {
      const http = new MockHttp();
      const { service } = buildService(http);

      await expect(
        service.sendPhone(KG, 'NOPE', '77011234567'),
      ).rejects.toBeInstanceOf(KaspiUnknownProcessError);
    });

    it('throws kaspi_unknown_process when process belongs to another kg', async () => {
      const http = new MockHttp();
      const { service } = buildService(http);
      http.enqueue({ json: { meta: { pId: 'PID-1' } }, setCookie: [] });
      await service.init(KG, USER);

      await expect(
        service.sendPhone('other-kg', 'PID-1', '77011234567'),
      ).rejects.toBeInstanceOf(KaspiUnknownProcessError);
    });
  });

  describe('verify-otp', () => {
    it('rejects an invalid OTP with kaspi_otp_invalid', async () => {
      const http = new MockHttp();
      const { service } = buildService(http);
      await driveToFinish(http, service);

      http.enqueue({ json: { view: { code: 'EnterOtp' } } }); // no success markers
      await expect(
        service.verifyOtp(KG, 'PID-1', '000000'),
      ).rejects.toBeInstanceOf(KaspiOtpInvalidError);
    });

    it('finishes, persists an active session with encrypted creds, and clears in-flight', async () => {
      const http = new MockHttp();
      const { service, store, repo } = buildService(http);
      await driveToFinish(http, service);

      // verify-otp OK
      http.enqueue({
        json: { data: { type: 'kpDeviceRegistration' } },
        setCookie: ['user_token=UT3'],
      });
      // finish OK (with server x509 for ECDH)
      http.enqueue({
        json: {
          success: true,
          data: { tokenSN: 'TSN-123', x509: serverEcdhX509() },
        },
      });
      // org-context
      http.enqueue({
        json: {
          Data: {
            Current: {
              ProfileId: 482931,
              OrganizationId: 700,
              OrganizationName: 'ТОО Солнышко',
            },
          },
        },
      });

      const result = await service.verifyOtp(KG, 'PID-1', '123456');

      expect(result).toEqual({
        connected: true,
        phone: '7011234567',
        orgName: 'ТОО Солнышко',
        profileId: '482931',
      });

      // In-flight blob (held the device key) is gone.
      expect(store.has('PID-1')).toBe(false);

      // Persisted row is active with encrypted creds (never plaintext).
      const row = repo.current(KG)!;
      const s = row.toState();
      expect(s.status).toBe('active');
      expect(s.tokenSn).toBe('TSN-123');
      expect(s.kaspiProfileId).toBe('482931');
      expect(s.kaspiOrgId).toBe('700');
      expect(s.vtokenSecretEnc?.startsWith('ENC:')).toBe(true);
      expect(s.deviceKeypairEnc?.startsWith('ENC:')).toBe(true);
      expect(s.ecdhKeypairEnc?.startsWith('ENC:')).toBe(true);
      expect(s.deviceId).toBeTruthy();
      expect(s.installId).toBeTruthy();
      expect(s.pinHash).toBeTruthy();

      // finish URL + org-context URL were the ones called.
      const urls = http.calls.map((c) => c.url);
      expect(urls).toContain(
        'https://entrance-pay.kaspi.kz/api/v1/kpentrance/finish',
      );
      expect(urls).toContain(
        'https://mtoken.kaspi.kz/v08/organizations/org-context-otp',
      );
    });

    it('does NOT activate when org-context returns no ProfileId (X-PI required for qrpay)', async () => {
      const http = new MockHttp();
      const { service, repo } = buildService(http);
      await driveToFinish(http, service);

      // verify-otp OK
      http.enqueue({
        json: { data: { type: 'kpDeviceRegistration' } },
        setCookie: ['user_token=UT3'],
      });
      // finish OK
      http.enqueue({
        json: {
          success: true,
          data: { tokenSN: 'TSN-123', x509: serverEcdhX509() },
        },
      });
      // org-context WITHOUT Data.Current.ProfileId
      http.enqueue({
        json: {
          Data: {
            Current: {
              OrganizationId: 700,
              OrganizationName: 'ТОО Солнышко',
            },
          },
        },
      });

      await expect(
        service.verifyOtp(KG, 'PID-1', '123456'),
      ).rejects.toBeInstanceOf(KaspiFinishFailedError);

      // No session row persisted (fake repo unchanged).
      expect(repo.current(KG)).toBeUndefined();
    });
  });

  describe('status', () => {
    it('returns disconnected when no row exists', async () => {
      const http = new MockHttp();
      const { service } = buildService(http);
      const s = await service.status(KG);
      expect(s).toEqual({ connected: false, status: 'disconnected' });
    });

    it('returns connected=true and phone/org without secrets for an active row', async () => {
      const http = new MockHttp();
      const { service, repo } = buildService(http);
      repo.seed(activeSession());
      const s = await service.status(KG);
      expect(s.connected).toBe(true);
      expect(s.status).toBe('active');
      expect(s.phone).toBe('77011234567');
      expect(s.orgName).toBe('ТОО Солнышко');
      expect(JSON.stringify(s)).not.toContain('ENC:');
    });
  });

  describe('disconnect', () => {
    it('revokes an existing session', async () => {
      const http = new MockHttp();
      const { service, repo } = buildService(http);
      repo.seed(activeSession());
      const res = await service.disconnect(KG);
      expect(res).toEqual({ status: 'revoked' });
      expect(repo.current(KG)!.status).toBe('revoked');
    });

    it('throws kaspi_not_connected when there is no session', async () => {
      const http = new MockHttp();
      const { service } = buildService(http);
      await expect(service.disconnect(KG)).rejects.toBeInstanceOf(
        KaspiNotConnectedError,
      );
    });
  });
});

// ─── Fixture builders ────────────────────────────────────────────────────────

function activeSession(): KaspiMerchantSession {
  const now = new Date('2026-06-01T00:00:00.000Z');
  return KaspiMerchantSession.fromState({
    id: crypto.randomUUID(),
    kindergartenId: KG,
    connectedByUserId: USER,
    status: 'active',
    cashierPhone: '77011234567',
    kaspiProfileId: '482931',
    kaspiOrgId: '700',
    orgName: 'ТОО Солнышко',
    tokenSn: 'TSN-OLD',
    vtokenSecretEnc: 'ENC:abc',
    deviceKeypairEnc: 'ENC:dev',
    ecdhKeypairEnc: 'ENC:ecdh',
    deviceId: 'DEV-1',
    installId: 'INS-1',
    pinHash: 'pin',
    lastCheckedAt: now,
    createdAt: now,
    updatedAt: now,
  });
}
