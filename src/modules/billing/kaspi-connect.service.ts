import * as crypto from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { CryptoCipherPort } from '@/shared-kernel/application/ports/crypto-cipher.port';
import { KaspiGlobalConfig } from './domain/kaspi-global-config';
import { KaspiGlobalConfigService } from './kaspi-global-config.service';
import {
  KaspiMerchantSession,
  KaspiMerchantSessionState,
} from './domain/entities/kaspi-merchant-session.entity';
import {
  KaspiAlreadyConnectedError,
  KaspiAppVersionOutdatedError,
  KaspiFinishFailedError,
  KaspiNotConnectedError,
  KaspiOtpInvalidError,
  KaspiUnknownProcessError,
} from './domain/errors/kaspi-connect.errors';
import { KaspiMerchantSessionRepository } from './infrastructure/persistence/kaspi-merchant-session.repository';
import {
  KaspiOnboardingState,
  KaspiOnboardingStorePort,
} from './infrastructure/onboarding/kaspi-onboarding-store.port';
import { KaspiHttpClient } from './infrastructure/payment-provider/kaspi/kaspi-http.client';
import {
  computeTokenSnMac,
  computeXSU,
  computeXSign,
  deriveEcdhSecret,
  ecSign,
  generateEcdhKeyPair,
} from './infrastructure/payment-provider/kaspi/kaspi-crypto';
import { nowISO } from './infrastructure/payment-provider/kaspi/kaspi-signed-headers';

/**
 * Result of a successful verify-otp → finish → org-context (the 200 body for
 * `POST /admin/kaspi/connect/verify-otp`).
 */
export interface KaspiConnectResult {
  connected: true;
  phone: string;
  orgName: string | null;
  profileId: string | null;
}

/** Current connection status (the 200 body for `GET /admin/kaspi/status`). */
export interface KaspiConnectStatus {
  connected: boolean;
  status: KaspiMerchantSessionState['status'] | 'disconnected';
  phone?: string;
  orgName?: string;
  lastCheckedAt?: Date;
}

/** Device fingerprint generated fresh per kindergarten at /init. */
interface DeviceIdentity {
  deviceId: string;
  installId: string;
  pinHash: string;
  pk: string;
  pkTag: string;
  privateKeyDerB64: string;
  publicKeyDerB64: string;
}

/**
 * KaspiConnectService — the SMS-onboarding orchestration (B24 / K5).
 *
 * A faithful 1:1 port of `kaspi_pay_test/src/routes/auth.js`
 * (init / send-phone / verify-otp / doFinish / refresh) +
 * `session.js#applyOrgContext`, adapted to:
 *   - per-tenant device identity (generated fresh per kindergarten at /init,
 *     held in the Redis in-flight blob, persisted at finish);
 *   - per-tenant encrypted credentials at-rest (CryptoCipherPort);
 *   - in-flight state in Redis keyed by processId (TTL 300s), NOT a Map;
 *   - the global config (app version/build/URLs/UA) from KaspiGlobalConfigService.
 *
 * Secrets hygiene: tokenSN, vtoken secret, raw ECDH secret, device private keys,
 * OTP and the full phone are NEVER logged or echoed in errors.
 */
@Injectable()
export class KaspiConnectService {
  constructor(
    private readonly config: KaspiGlobalConfigService,
    private readonly http: KaspiHttpClient,
    private readonly store: KaspiOnboardingStorePort,
    private readonly repo: KaspiMerchantSessionRepository,
    private readonly cipher: CryptoCipherPort,
    private readonly clock: ClockPort,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════
  //  Step 1 — init (entrance/step). NO SMS is sent here.
  // ═══════════════════════════════════════════════════════════════════════

  async init(
    kindergartenId: string,
    connectedByUserId: string,
  ): Promise<{ processId: string }> {
    // Guard: a kindergarten may have only one active session. Re-onboarding
    // requires an explicit disconnect first (§2.25 409).
    const existing = await this.repo.findByKindergartenId(kindergartenId);
    if (existing && existing.isActive()) {
      throw new KaspiAlreadyConnectedError();
    }

    const cfg = await this.config.getConfig();
    const device = this.generateDeviceIdentity();

    const url = `${cfg.entranceUrl}/api/v1/entrance/step`;
    const referer =
      `${cfg.entranceUrl}/process/entrance/?auth=2&appBuild=${cfg.appBuild}` +
      `&appVersion=${cfg.appVersion}&platformVersion=${cfg.platformVer}` +
      `&platformType=IOS&deviceBrand=${cfg.brand}&deviceModel=${cfg.model}` +
      `&deviceId=${device.deviceId}&installId=${device.installId}` +
      `&frontCameraAvailable=true&sf=registration&pc=KPEntrance&noPass=0`;

    const { json, setCookie } = await this.http.request('POST', url, {
      headers: {
        ...this.entranceHeadersBase(cfg),
        Referer: referer,
        Cookie: this.entranceCookie(cfg, device, null),
      },
      body: {
        data: {},
        Data: {
          auth: '2',
          appBuild: cfg.appBuild,
          appVersion: cfg.appVersion,
          platformVersion: cfg.platformVer,
          platformType: 'IOS',
          deviceBrand: cfg.brand,
          deviceModel: cfg.model,
          deviceId: device.deviceId,
          installId: device.installId,
          frontCameraAvailable: 'true',
          sf: 'registration',
          pc: 'KPEntrance',
          noPass: '0',
        },
        actType: 'Success',
      },
    });

    // Version gate fires BEFORE phone entry: view.onOpenAlarm.error.code.
    if (this.extractAlarmCode(json) === 'OldVersionToUpdate') {
      throw new KaspiAppVersionOutdatedError();
    }

    const body = json as Record<string, unknown> | null;
    const meta = body?.['meta'] as Record<string, unknown> | undefined;
    const processId = meta?.['pId'] as string | undefined;
    if (!processId) {
      // No processId and no version alarm — treat as an upstream failure.
      throw new KaspiFinishFailedError('init_no_process_id');
    }

    const userToken = this.extractUserToken(setCookie);

    const state: KaspiOnboardingState = {
      kindergartenId,
      connectedByUserId,
      processId,
      userToken,
      phoneNumber: null,
      deviceId: device.deviceId,
      installId: device.installId,
      pinHash: device.pinHash,
      pk: device.pk,
      pkTag: device.pkTag,
      devicePrivateKeyDerB64: device.privateKeyDerB64,
      devicePublicKeyDerB64: device.publicKeyDerB64,
    };
    await this.store.put(state);

    return { processId };
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  Step 2 — send-phone (triggers the SMS OTP to the cashier).
  // ═══════════════════════════════════════════════════════════════════════

  async sendPhone(
    kindergartenId: string,
    processId: string,
    phoneNumber: string,
  ): Promise<{ processId: string; smsSent: boolean }> {
    const cfg = await this.config.getConfig();
    const state = await this.requireState(kindergartenId, processId);
    const device = this.deviceFromState(state);

    const url = `${cfg.entranceUrl}/api/v1/entrance/step`;
    const referer =
      `${cfg.entranceUrl}/process/universal-enter-phone-number?pId=${processId}` +
      `&firstPage=KPUniversalEnterPhoneNumber`;

    const { json, setCookie } = await this.http.request('POST', url, {
      headers: {
        ...this.entranceHeadersBase(cfg),
        Referer: referer,
        Cookie: this.entranceCookie(cfg, device, state.userToken),
      },
      body: {
        meta: { pId: processId, sn: 'EnterPhoneNumber' },
        data: { phoneNumber },
        actType: 'Success',
      },
    });

    // Surface an upstream failure as an error — never a 200 with sms_sent:false.
    if (this.extractAlarmCode(json) === 'OldVersionToUpdate') {
      throw new KaspiAppVersionOutdatedError();
    }

    const body = json as Record<string, unknown> | null;
    const view = body?.['view'] as Record<string, unknown> | undefined;
    const smsSent = view?.['code'] === 'EnterOtp';
    if (!smsSent) {
      throw new KaspiFinishFailedError('send_phone_failed');
    }

    // Persist the rotated user_token + the captured phone for the OTP step
    // only once we know the SMS was actually sent.
    await this.store.put({
      ...state,
      phoneNumber,
      userToken: this.extractUserToken(setCookie) ?? state.userToken,
    });

    return { processId, smsSent };
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  Step 3 — verify-otp → (success) doFinish → org-context → persist.
  // ═══════════════════════════════════════════════════════════════════════

  async verifyOtp(
    kindergartenId: string,
    processId: string,
    otp: string,
  ): Promise<KaspiConnectResult> {
    const cfg = await this.config.getConfig();
    const state = await this.requireState(kindergartenId, processId);
    const device = this.deviceFromState(state);

    const url = `${cfg.entranceUrl}/api/v1/entrance/step`;
    const referer =
      `${cfg.entranceUrl}/process/universal-enter-phone-number?pId=${processId}` +
      `&firstPage=KPUniversalEnterPhoneNumber`;

    const { json, setCookie } = await this.http.request('POST', url, {
      headers: {
        ...this.entranceHeadersBase(cfg),
        Referer: referer,
        Cookie: this.entranceCookie(cfg, device, state.userToken),
      },
      body: {
        meta: { pId: processId, sn: 'ViewEnterOtp' },
        data: { userOtp: otp, inputType: 'auto' },
        actType: 'Success',
      },
    });

    const body = json as Record<string, unknown> | null;
    const data = body?.['data'] as Record<string, unknown> | undefined;
    const view = body?.['view'] as Record<string, unknown> | undefined;
    const otpOk =
      data?.['type'] === 'kpDeviceRegistration' ||
      view?.['code'] === 'KPMobileCall';
    if (!otpOk) {
      throw new KaspiOtpInvalidError();
    }

    // Refresh the user_token one last time before finish.
    const refreshedState: KaspiOnboardingState = {
      ...state,
      userToken: this.extractUserToken(setCookie) ?? state.userToken,
    };

    const result = await this.doFinish(cfg, refreshedState);
    // Onboarding complete — drop the in-flight blob (holds the device key).
    await this.store.delete(processId);
    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  doFinish — entrance/finish (ECDH exchange) → org-context → persist row.
  // ═══════════════════════════════════════════════════════════════════════

  private async doFinish(
    cfg: KaspiGlobalConfig,
    state: KaspiOnboardingState,
  ): Promise<KaspiConnectResult> {
    const devicePrivateKey = crypto.createPrivateKey({
      key: Buffer.from(state.devicePrivateKeyDerB64, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });

    // Fresh ECDH keypair for the guard.x509 / vtoken key agreement.
    const ecdh = generateEcdhKeyPair();

    const signedDataObj = {
      installId: state.installId,
      time: nowISO(this.clock.now()),
      auth: [{ value: '', type: 'pincode' }],
      userIdHash: '',
    };
    const signedDataB64 = Buffer.from(JSON.stringify(signedDataObj)).toString(
      'base64',
    );

    const finishUrl = `${cfg.entranceUrl}/api/v1/kpentrance/finish`;
    const finishHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: '*/*',
      'Accept-Language': 'ru',
      'Accept-Encoding': 'gzip, deflate, br',
      'User-Agent': cfg.uaNative,
      'X-Time': nowISO(this.clock.now()),
      'X-Call': 'notConnected',
      'X-Platform-Type': KASPI_PLATFORM,
      'X-PkTag': state.pkTag,
      'X-SU': computeXSU(finishUrl),
      'X-Net-Type': 'WIFI/ETHERNET',
      'X-Emulator': '0',
      'X-Locale': KASPI_LOCALE,
      'X-SV': '2',
      'X-Request-ID': generateRequestId(),
      'X-Time-Zone': 'GMT+05:00',
      'X-SH':
        'url,X-Time-Zone,X-Request-ID,X-Net-Type,X-Emulator,X-Call,X-Platform-Type,X-Locale,X-Time,X-SV',
    };
    finishHeaders['X-Sign'] = computeXSign(
      finishUrl,
      finishHeaders,
      finishHeaders['X-SH'],
      devicePrivateKey,
    );

    const { json: finishJson } = await this.http.request('POST', finishUrl, {
      headers: finishHeaders,
      body: {
        signed: {
          sign: ecSign(signedDataB64, devicePrivateKey),
          data: signedDataB64,
        },
        guard: { pinHash: state.pinHash, x509: ecdh.publicSpkiB64 },
        processId: state.processId,
      },
    });

    const finishBody = finishJson as Record<string, unknown> | null;
    const finishData = finishBody?.['data'] as
      | Record<string, unknown>
      | undefined;
    const tokenSN = finishData?.['tokenSN'] as string | undefined;
    if (!finishBody?.['success'] || !tokenSN) {
      // No raw Kaspi body in the public message — only a stable internal tag.
      throw new KaspiFinishFailedError('finish_no_token_sn');
    }

    // Derive the raw ECDH shared secret (the vtoken MAC key). Null if Kaspi
    // omitted its x509 — MAC then falls back to '000000' downstream.
    let rawSecret: Buffer | null = null;
    const serverX509 = finishData?.['x509'] as string | undefined;
    if (serverX509) {
      rawSecret = deriveEcdhSecret(ecdh.privateKeyDerB64, serverX509);
    }

    // ── org-context-otp ─────────────────────────────────────────────────
    const orgContext = await this.fetchOrgContext(
      cfg,
      state,
      devicePrivateKey,
      tokenSN,
      rawSecret,
      null,
    );

    // profileId (X-PI) is required to sign qrpay payment requests. An "active"
    // session without it produces broken payments — refuse to activate when
    // org-context returned no Data.Current.ProfileId.
    if (orgContext.profileId == null) {
      throw new KaspiFinishFailedError('finish_no_org_context');
    }

    // ── Persist the session row (status=active, encrypted creds) ─────────
    const now = this.clock.now();
    const ecdhKeypairJson = JSON.stringify({
      privateKey: ecdh.privateKeyDerB64,
      publicKey: ecdh.publicKeyDerB64,
    });
    const deviceKeypairJson = JSON.stringify({
      privateKey: state.devicePrivateKeyDerB64,
      publicKey: state.devicePublicKeyDerB64,
    });

    const existing = await this.repo.findByKindergartenId(state.kindergartenId);
    const session = existing ?? this.newPendingSession(state, now);
    session.activate(
      {
        cashierPhone: state.phoneNumber ?? '',
        kaspiProfileId: orgContext.profileId,
        kaspiOrgId: orgContext.organizationId,
        orgName: orgContext.orgName,
        tokenSn: tokenSN,
        vtokenSecretEnc: rawSecret
          ? this.cipher.encrypt(rawSecret)
          : this.cipher.encryptString(''),
        deviceKeypairEnc: this.cipher.encryptString(deviceKeypairJson),
        ecdhKeypairEnc: this.cipher.encryptString(ecdhKeypairJson),
        deviceId: state.deviceId,
        installId: state.installId,
        pinHash: state.pinHash,
      },
      now,
    );
    const saved = await this.repo.save(session);

    return {
      connected: true,
      phone: saved.cashierPhone ?? '',
      orgName: saved.orgName,
      profileId: saved.kaspiProfileId,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  refresh — SignInLite (v03/auth/sign-in-lite) + org-context.
  //  Exposed for the K8 poller; NO controller endpoint (§2.25).
  // ═══════════════════════════════════════════════════════════════════════

  async refreshSession(kindergartenId: string): Promise<KaspiMerchantSession> {
    const cfg = await this.config.getConfig();
    const session =
      await this.repo.findByKindergartenIdBypassRls(kindergartenId);
    if (!session) {
      throw new KaspiNotConnectedError();
    }

    const state = session.toState();
    if (
      !state.tokenSn ||
      !state.vtokenSecretEnc ||
      !state.deviceKeypairEnc ||
      !state.ecdhKeypairEnc ||
      !state.installId ||
      !state.pinHash
    ) {
      throw new KaspiFinishFailedError('refresh_missing_credentials');
    }

    const devicePrivateKey = this.devicePrivateKeyFromEnc(
      state.deviceKeypairEnc,
    );
    // A 0-length decrypted buffer (Kaspi previously omitted x509, stored as
    // encrypted '') maps to null so `computeTokenSnMac` falls back to '000000'
    // rather than HMAC-ing with an empty key — mirrors the payment adapter.
    const decrypted = this.cipher.decrypt(state.vtokenSecretEnc);
    const rawSecret = decrypted.length > 0 ? decrypted : null;
    const ecdhPrivDerB64 = this.ecdhPrivateKeyDerFromEnc(state.ecdhKeypairEnc);

    const liteUrl = `${cfg.mtokenUrl}/v03/auth/sign-in-lite`;
    const liteHeaders = this.mtokenHeaders(
      cfg,
      liteUrl,
      devicePrivateKey,
      state.installId,
      state.tokenSn,
      rawSecret,
      null,
    );

    const { json } = await this.http.request('POST', liteUrl, {
      headers: liteHeaders,
      body: {
        OrganizationId: state.kaspiOrgId ? Number(state.kaspiOrgId) : 0,
        DeviceInformation: this.deviceInformation(cfg, state),
      },
    });

    const body = json as Record<string, unknown> | null;
    const statusCode = body?.['StatusCode'];
    const data = body?.['Data'] as Record<string, unknown> | undefined;
    if (statusCode !== 0 || !data) {
      // SignInLite failed — token likely fully expired; re-auth via SMS needed.
      const now = this.clock.now();
      session.markExpired(now);
      // Runs in the K8 worker without an ambient tenant TX — persist under a
      // self-contained bypass-RLS TX or the FORCE-RLS write affects 0 rows.
      await this.repo.saveBypassRls(session);
      throw new KaspiFinishFailedError('sign_in_lite_failed');
    }

    const newTokenSN =
      (data['TokenSn'] as string | undefined) ??
      (data['tokenSN'] as string | undefined) ??
      state.tokenSn;

    // Re-key the ECDH secret if Kaspi rotated its x509 (reuses our stored
    // ECDH private key, mirroring completeECDHWithSaved).
    let newRawSecret = rawSecret;
    const serverX509 =
      (data['X509'] as string | undefined) ??
      (data['x509'] as string | undefined);
    if (serverX509) {
      newRawSecret = deriveEcdhSecret(ecdhPrivDerB64, serverX509);
    }

    const orgContext = await this.fetchOrgContext(
      cfg,
      {
        deviceId: state.deviceId ?? '',
        installId: state.installId,
        pinHash: state.pinHash,
        kindergartenId,
      } as KaspiOnboardingState,
      devicePrivateKey,
      newTokenSN,
      newRawSecret,
      state.kaspiOrgId ? Number(state.kaspiOrgId) : 0,
    );

    const now = this.clock.now();
    session.applyRefresh(
      {
        tokenSn: newTokenSN,
        // Guard against a null secret (Kaspi omitted x509) — store encrypted ''
        // like doFinish does, so refresh round-trips the absence faithfully.
        vtokenSecretEnc: newRawSecret
          ? this.cipher.encrypt(newRawSecret)
          : this.cipher.encryptString(''),
        kaspiProfileId: orgContext.profileId,
        kaspiOrgId: orgContext.organizationId,
        orgName: orgContext.orgName,
      },
      now,
    );
    // K8 worker path — persist under bypass-RLS (see markExpired branch above).
    return this.repo.saveBypassRls(session);
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  status / disconnect.
  // ═══════════════════════════════════════════════════════════════════════

  async status(kindergartenId: string): Promise<KaspiConnectStatus> {
    const session = await this.repo.findByKindergartenId(kindergartenId);
    if (!session) {
      return { connected: false, status: 'disconnected' };
    }
    return {
      connected: session.isActive(),
      status: session.status,
      ...(session.cashierPhone ? { phone: session.cashierPhone } : {}),
      ...(session.orgName ? { orgName: session.orgName } : {}),
      ...(session.lastCheckedAt
        ? { lastCheckedAt: session.lastCheckedAt }
        : {}),
    };
  }

  async disconnect(kindergartenId: string): Promise<{ status: 'revoked' }> {
    const session = await this.repo.findByKindergartenId(kindergartenId);
    if (!session) {
      throw new KaspiNotConnectedError();
    }
    session.revoke(this.clock.now());
    await this.repo.save(session);
    return { status: 'revoked' };
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  org-context-otp (shared by finish + refresh).
  // ═══════════════════════════════════════════════════════════════════════

  private async fetchOrgContext(
    cfg: KaspiGlobalConfig,
    state: KaspiOnboardingState,
    devicePrivateKey: crypto.KeyObject,
    tokenSN: string,
    rawSecret: Buffer | null,
    organizationId: number | null,
  ): Promise<{
    profileId: string | null;
    organizationId: string | null;
    orgName: string | null;
  }> {
    const orgUrl = `${cfg.mtokenUrl}/v08/organizations/org-context-otp`;
    // profileId is absent on first onboarding → use the no-PI X-SH variant
    // (the reference branches X-SH on whether profileId is known).
    const orgHeaders = this.mtokenHeaders(
      cfg,
      orgUrl,
      devicePrivateKey,
      state.installId,
      tokenSN,
      rawSecret,
      null,
    );

    const { json } = await this.http.request('POST', orgUrl, {
      headers: orgHeaders,
      body: {
        DeviceInformation: this.deviceInformation(cfg, state),
        OrganizationId: organizationId ?? 0,
      },
    });

    return this.applyOrgContext(json);
  }

  /**
   * Port of `session.js#applyOrgContext` — reads `Data.Current` into the fields
   * we persist (profileId, orgName, organizationId).
   */
  private applyOrgContext(json: unknown): {
    profileId: string | null;
    organizationId: string | null;
    orgName: string | null;
  } {
    const body = json as Record<string, unknown> | null;
    const data = body?.['Data'] as Record<string, unknown> | undefined;
    const cur = data?.['Current'] as Record<string, unknown> | undefined;
    const profileId = cur?.['ProfileId'];
    const orgId = cur?.['OrganizationId'];
    const orgName = cur?.['OrganizationName'];
    return {
      profileId: profileId != null ? String(profileId) : null,
      organizationId: orgId != null ? String(orgId) : null,
      orgName: orgName != null ? String(orgName) : null,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  Header / cookie / body builders (verbatim ports).
  // ═══════════════════════════════════════════════════════════════════════

  private entranceHeadersBase(cfg: KaspiGlobalConfig): Record<string, string> {
    return {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'Accept-Language': 'ru',
      'Accept-Encoding': 'gzip, deflate, br',
      Origin: cfg.entranceUrl,
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty',
      'User-Agent': cfg.uaBrowser,
    };
  }

  private entranceCookie(
    cfg: KaspiGlobalConfig,
    device: { deviceId: string; installId: string; pk: string; pkTag: string },
    userToken: string | null,
  ): string {
    let c =
      `deviceId=${device.deviceId}; installId=${device.installId}; ` +
      `is_mobile_app=true; locale=${KASPI_LOCALE}; ma_bld=${cfg.appBuild}; ` +
      `ma_platform_type=${KASPI_PLATFORM}; ma_platform_ver=${cfg.platformVer}; ` +
      `ma_ver=${cfg.appVersion}; pk=${device.pk}; pkTag=${device.pkTag}; ` +
      `xs=R:0|E:0|RH:0|N:0`;
    if (userToken) c += `; user_token=${userToken}`;
    return c;
  }

  /**
   * mtoken / qrpay native-API headers (org-context-otp + sign-in-lite). Both
   * the reference call-sites use the SAME X-SH list when profileId is absent.
   * When a profileId is supplied we add `X-PI` and switch to the with-PI X-SH
   * variant — matching `doFinish`'s `piValue ? … : …` branch verbatim.
   */
  private mtokenHeaders(
    cfg: KaspiGlobalConfig,
    url: string,
    devicePrivateKey: crypto.KeyObject,
    installId: string,
    tokenSN: string,
    rawSecret: Buffer | null,
    profileId: string | null,
  ): Record<string, string> {
    const piValue = profileId != null ? String(profileId) : '';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: '*/*',
      'Accept-Language': 'ru',
      'Accept-Encoding': 'gzip, deflate, br',
      'User-Agent': cfg.uaNative,
      'X-Kb-TokenSn': tokenSN,
      'X-Kb-TokenSnMac': computeTokenSnMac(
        tokenSN,
        rawSecret,
        this.clock.now().getTime(),
      ),
      'X-Install-ID': installId,
      'X-App-Ver': cfg.appVersion,
      'X-App-Bld': cfg.appBuild,
      'X-Locale': KASPI_LOCALE,
      'X-Call': 'notConnected',
      'X-Time': nowISO(this.clock.now()),
      'X-S': 'R:0|E:0|RH:0|N:0',
      'X-SV': '2',
      'X-Kb-Client-Ip': '192.168.1.96',
      'X-PkTag': '',
      'X-SU': computeXSU(url),
      'X-SH': piValue
        ? 'url,X-Kb-Client-Ip,X-App-Bld,X-S,X-Kb-TokenSn,X-Time,X-App-Ver,X-Kb-TokenSnMac,X-Call,X-PI,X-Install-ID,X-Locale,X-SV'
        : 'url,X-Kb-Client-Ip,X-Time,X-App-Ver,X-SV,X-Locale,X-App-Bld,X-Install-ID,X-Kb-TokenSn,X-S,X-Kb-TokenSnMac,X-Call',
      'X-Request-ID': generateRequestId(),
    };
    if (piValue) headers['X-PI'] = piValue;
    headers['X-Sign'] = computeXSign(
      url,
      headers,
      headers['X-SH'],
      devicePrivateKey,
    );
    return headers;
  }

  private deviceInformation(
    cfg: KaspiGlobalConfig,
    state: { deviceId?: string | null; installId: string | null },
  ): Record<string, unknown> {
    return {
      SdkVersion: 'AOTP service',
      DeviceId: state.deviceId ?? '',
      ApplicationId: 'kz.kaspi.business',
      ScreenWidth: '393.0',
      Model: cfg.model,
      ScreenHeight: '852.0',
      DeviceName: 'iPhone',
      VersionName: cfg.appVersion,
      BuildRelease: `${KASPI_PLATFORM} ${cfg.platformVer}`,
      Brand: cfg.brand,
      Board: cfg.platformVer,
      Platform: KASPI_PLATFORM,
      Product: 'Kaspi Pay',
      frontCameraAvailable: true,
      VersionCode: cfg.appBuild,
      InstallId: state.installId ?? '',
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  Helpers.
  // ═══════════════════════════════════════════════════════════════════════

  private async requireState(
    kindergartenId: string,
    processId: string,
  ): Promise<KaspiOnboardingState> {
    const state = await this.store.get(processId);
    // Unknown / expired processId OR a processId that belongs to a different
    // kindergarten (cross-tenant guard) → 400 kaspi_unknown_process.
    if (!state || state.kindergartenId !== kindergartenId) {
      throw new KaspiUnknownProcessError();
    }
    return state;
  }

  private generateDeviceIdentity(): DeviceIdentity {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    });
    const privateKeyDerB64 = privateKey
      .export({ type: 'pkcs8', format: 'der' })
      .toString('base64');
    const pubDer = publicKey.export({ type: 'spki', format: 'der' });
    const publicKeyDerB64 = pubDer.toString('base64');
    // pk = base64 of the last 65 bytes of the SPKI DER (uncompressed EC point).
    const pk = pubDer.subarray(pubDer.length - 65).toString('base64');
    const pkTag = crypto.createHash('md5').update(pk).digest('hex');
    const pinHash = crypto
      .createHash('md5')
      .update(crypto.randomBytes(16))
      .digest('hex');
    return {
      deviceId: crypto.randomUUID().toUpperCase(),
      installId: crypto.randomUUID().toUpperCase(),
      pinHash,
      pk,
      pkTag,
      privateKeyDerB64,
      publicKeyDerB64,
    };
  }

  private deviceFromState(state: KaspiOnboardingState): {
    deviceId: string;
    installId: string;
    pk: string;
    pkTag: string;
  } {
    return {
      deviceId: state.deviceId,
      installId: state.installId,
      pk: state.pk,
      pkTag: state.pkTag,
    };
  }

  private newPendingSession(
    state: KaspiOnboardingState,
    now: Date,
  ): KaspiMerchantSession {
    return KaspiMerchantSession.fromState({
      id: crypto.randomUUID(),
      kindergartenId: state.kindergartenId,
      connectedByUserId: state.connectedByUserId,
      status: 'pending',
      cashierPhone: null,
      kaspiProfileId: null,
      kaspiOrgId: null,
      orgName: null,
      tokenSn: null,
      vtokenSecretEnc: null,
      deviceKeypairEnc: null,
      ecdhKeypairEnc: null,
      deviceId: null,
      installId: null,
      pinHash: null,
      lastCheckedAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  private devicePrivateKeyFromEnc(deviceKeypairEnc: string): crypto.KeyObject {
    const json = JSON.parse(this.cipher.decryptString(deviceKeypairEnc)) as {
      privateKey: string;
    };
    return crypto.createPrivateKey({
      key: Buffer.from(json.privateKey, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
  }

  private ecdhPrivateKeyDerFromEnc(ecdhKeypairEnc: string): string {
    const json = JSON.parse(this.cipher.decryptString(ecdhKeypairEnc)) as {
      privateKey: string;
    };
    return json.privateKey;
  }

  private extractUserToken(setCookie: string[]): string | null {
    for (const c of setCookie) {
      const m = c.match(/user_token=([^;]+)/);
      if (m) return m[1];
    }
    return null;
  }

  private extractAlarmCode(json: unknown): string | undefined {
    const view = (json as Record<string, unknown> | null)?.['view'] as
      | Record<string, unknown>
      | undefined;
    const alarm = view?.['onOpenAlarm'] as Record<string, unknown> | undefined;
    const error = alarm?.['error'] as Record<string, unknown> | undefined;
    return error?.['code'] as string | undefined;
  }
}

// ─── Onboarding-flow constants ────────────────────────────────────────────
// `locale` is the decided CONSTANT 'ru-RU' (not version-gated, not stored in
// config). `platform` is the iOS cookie/header value. Both mirror config.js.
const KASPI_LOCALE = 'ru-RU';
const KASPI_PLATFORM = 'iOS';

function generateRequestId(): string {
  return crypto.randomUUID().toUpperCase();
}
