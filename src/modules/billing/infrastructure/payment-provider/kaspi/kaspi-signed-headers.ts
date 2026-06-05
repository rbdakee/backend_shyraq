import * as crypto from 'crypto';
import { QRPAY_XSH, computeTokenSnMac, computeXSign } from './kaspi-crypto';

/**
 * Assembles and signs the full set of headers for a Kaspi `qrpay` request — a
 * 1:1 port of `signedQrPayHeaders` (`kaspi_pay_test/src/helpers.js`). PURE: all
 * device identity, app config, session secrets and the clock/id source are passed
 * as explicit parameters (the reference read module-global `DEVICE`/`APP`/`UA_NATIVE`
 * and called live `Date.now()`/`randomUUID()`).
 *
 * The X-SH header order and the X-Sign signing order are load-bearing — a single
 * reordered field breaks live payments.
 */

export interface KaspiSession {
  /** vtoken serial number (`X-Kb-TokenSn`). */
  tokenSN: string;
  /** Decrypted ECDH shared secret for the TOTP-MAC, or null → MAC '000000'. */
  decryptedSecret: Buffer | null;
  /** Merchant profile id (`X-PI`); empty string when absent. */
  profileId?: string | number | null;
}

export interface KaspiDeviceIdentity {
  /** `X-Device-ID`. */
  deviceId: string;
  /** `X-Install-ID`. */
  installId: string;
  /** Per-tenant device ECDSA P-256 private key used to sign requests. */
  privateKey: crypto.KeyObject;
}

export interface KaspiAppConfig {
  /** `X-App-Ver`, e.g. '4.110.1'. */
  version: string;
  /** `X-App-Bld`, e.g. '1076'. */
  build: string;
  /** `X-Platform-Type`, e.g. 'iOS'. */
  platform: string;
  /** `X-Platform-Ver`, e.g. '18.5'. */
  platformVer: string;
  /** `X-Locale`, e.g. 'ru-RU'. */
  locale: string;
  /** `User-Agent`, e.g. 'Kaspi%20Pay/1076 CFNetwork/3826.500.131 Darwin/24.5.0'. */
  uaNative: string;
}

export interface KaspiHeaderOverrides {
  /** Pin `X-Request-ID` (default: random UUID, uppercased). */
  requestId?: string;
  /** Pin `X-Time` (default: `nowISO()`). */
  timeIso?: string;
  /** Pin the epoch-ms used for the TOTP-MAC (default: Date.now()). */
  nowMs?: number;
}

/**
 * Local-offset ISO-8601 timestamp with millisecond precision, e.g.
 * `2026-06-04T19:00:00.123+05:00`. Verbatim port of the reference `nowISO`.
 */
export function nowISO(date: Date = new Date()): string {
  const off = -date.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0');
  const mm = String(Math.abs(off) % 60).padStart(2, '0');
  return (
    date
      .toISOString()
      .replace('Z', '')
      .replace(
        /\.\d{3}/,
        `.${String(date.getMilliseconds()).padStart(3, '0')}`,
      ) +
    sign +
    hh +
    mm
  );
}

/** Random request id — `crypto.randomUUID()` uppercased (port of `generateUUID`). */
function generateRequestId(): string {
  return crypto.randomUUID().toUpperCase();
}

/**
 * Builds the complete, signed `qrpay` header set. Returns a plain object that can
 * be handed directly to `KaspiHttpClient`. The returned `X-Sign` is computed over
 * the header values in `QRPAY_XSH` order (which does NOT include `X-SH`).
 */
export function signedQrPayHeaders(
  url: string,
  session: KaspiSession,
  deviceIdentity: KaspiDeviceIdentity,
  appConfig: KaspiAppConfig,
  overrides: KaspiHeaderOverrides = {},
): Record<string, string> {
  // Derive both the TOTP-MAC epoch and the X-Time header from a SINGLE clock
  // capture. Both X-Time and X-Kb-TokenSnMac are part of the signed X-Sign
  // payload; deriving them from separate Date reads could straddle a 30s TOTP
  // window boundary and produce an internally-inconsistent signed request.
  const nowMs = overrides.nowMs ?? Date.now();
  const timeIso = overrides.timeIso ?? nowISO(new Date(nowMs));
  const requestId = overrides.requestId ?? generateRequestId();

  const headers: Record<string, string> = {
    'X-Kb-TokenSn': session.tokenSN,
    'X-Kb-TokenSnMac': computeTokenSnMac(
      session.tokenSN,
      session.decryptedSecret,
      nowMs,
    ),
    'X-PI': session.profileId != null ? String(session.profileId) : '',
    'X-Install-ID': deviceIdentity.installId,
    'X-Device-ID': deviceIdentity.deviceId,
    'X-App-Ver': appConfig.version,
    'X-App-Bld': appConfig.build,
    'X-Platform-Type': appConfig.platform,
    'X-Platform-Ver': appConfig.platformVer,
    'X-Locale': appConfig.locale,
    'X-Time': timeIso,
    'X-Request-ID': requestId,
    'X-Call': 'notConnected',
    'X-SV': '2',
    'X-SH': QRPAY_XSH,
    'User-Agent': appConfig.uaNative,
    Accept: '*/*',
    'Accept-Language': 'ru',
    'Accept-Encoding': 'gzip, deflate, br',
  };

  headers['X-Sign'] = computeXSign(
    url,
    headers,
    QRPAY_XSH,
    deviceIdentity.privateKey,
  );

  return headers;
}
