import * as crypto from 'crypto';

/**
 * Kaspi request-signing crypto core — a 1:1 port of the reverse-engineered
 * reference implementation (`kaspi_pay_test/src/crypto.js`). Every byte here is
 * load-bearing: the OCRA suite string, the 30000ms TOTP time-step, the big-endian
 * dynamic-truncation byte order, and the SPKI/PKCS8 DER encodings are validated
 * by the live Kaspi `qrpay` API. Do NOT "improve" any algorithm.
 *
 * All functions are PURE: no DB, no fs, no module-global mutable state. Every
 * input (device identity, session secrets, ECDSA keys, clock) is passed as an
 * explicit parameter. The reference read `config.js` (fs) and used a module-global
 * `ecKeyPair`; that is deliberately NOT replicated — keys and config arrive from
 * the per-tenant `kaspi_global_config` table in later batch steps.
 *
 * Note: AES-256-GCM secret encryption from the reference is intentionally absent
 * here — it already lives in `AesGcmCryptoCipherAdapter` (batch step K1).
 */

/** OCRA-1 suite identifier used by the Kaspi vtoken MAC. Verbatim — do not edit. */
const VTOKEN_SUITE = 'OCRA-1:HOTP-SHA256-6:QH64-T1M';

/** TOTP time-step in milliseconds (Kaspi uses a 30-second window). */
const TIME_STEP_MS = 30000n;

/**
 * Default X-SH signing list for `qrpay` requests, in EXACT order. This list is
 * the order in which header values are concatenated to form the X-Sign payload.
 * `X-SH` itself is present in the headers object but is NOT part of this list, so
 * it is never part of the signed bytes — preserve this exactly.
 */
export const QRPAY_XSH =
  'url,X-Request-ID,X-Device-ID,X-Platform-Ver,X-App-Bld,X-Time,X-Kb-TokenSn,X-App-Ver,X-Kb-TokenSnMac,X-Call,X-PI,X-Install-ID,X-Platform-Type,X-Locale,X-SV';

/** Parses an even-length hex string into a Buffer (verbatim port). */
function hexToBytes(hex: string): Buffer {
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.substring(i, i + 2), 16));
  }
  return Buffer.from(bytes);
}

export interface EcdhKeyMaterial {
  /** PKCS8 DER private key, base64. Caller persists this (encrypted) in K5. */
  privateKeyDerB64: string;
  /** SPKI DER public key, base64. */
  publicKeyDerB64: string;
  /** Alias of `publicKeyDerB64` — the value sent to Kaspi as the client pubkey. */
  publicSpkiB64: string;
}

/**
 * Generates a fresh P-256 ECDH keypair and returns the DER material as base64.
 * Port of the reference `generateECDH` WITHOUT the fs persistence side-effect —
 * the caller is responsible for storing the private key encrypted (K5).
 */
export function generateEcdhKeyPair(): EcdhKeyMaterial {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  const privateKeyDerB64 = privateKey
    .export({ type: 'pkcs8', format: 'der' })
    .toString('base64');
  const publicKeyDerB64 = publicKey
    .export({ type: 'spki', format: 'der' })
    .toString('base64');
  return {
    privateKeyDerB64,
    publicKeyDerB64,
    publicSpkiB64: publicKeyDerB64,
  };
}

/**
 * Derives the ECDH shared secret from an explicitly-passed client private key
 * (PKCS8 DER base64) and the server's public key (SPKI/X.509 DER base64). Port of
 * the reference `completeECDHWithSaved`, but the private key is passed in rather
 * than read from fs. Returns the raw shared-secret Buffer used as the TOTP-MAC key.
 */
export function deriveEcdhSecret(
  privateKeyDerB64: string,
  serverX509B64: string,
): Buffer {
  const privateKey = crypto.createPrivateKey({
    key: Buffer.from(privateKeyDerB64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  const serverPubKey = crypto.createPublicKey({
    key: Buffer.from(serverX509B64, 'base64'),
    format: 'der',
    type: 'spki',
  });
  return crypto.diffieHellman({ privateKey, publicKey: serverPubKey });
}

/**
 * Computes the `X-Kb-TokenSnMac` — an OCRA-1 / TOTP MAC over the token serial.
 * Verbatim port; the only addition is the explicit `nowMs` parameter (the
 * reference hard-coded `Date.now()`) so callers and tests can pin the instant.
 *
 * @param tokenSN  the vtoken serial number.
 * @param secret   the ECDH shared secret (HMAC key), or null → '000000'.
 * @param nowMs    the current epoch milliseconds. Defaults to Date.now().
 */
export function computeTokenSnMac(
  tokenSN: string,
  secret: Buffer | null,
  nowMs: number = Date.now(),
): string {
  if (!secret) return '000000';

  const timeStep = BigInt(nowMs) / TIME_STEP_MS;
  const timeHex = timeStep.toString(16);

  const qHex = Buffer.from(tokenSN || '00000000')
    .toString('hex')
    .substring(0, 64);

  const suiteBytes = Buffer.from(VTOKEN_SUITE);
  const separator = Buffer.from([0x00]);

  const qPadded = qHex.padEnd(256, '0');
  const qBytes = hexToBytes(qPadded);

  const tPadded = timeHex.padStart(16, '0');
  const tBytes = hexToBytes(tPadded);

  const dataBuffer = Buffer.concat([suiteBytes, separator, qBytes, tBytes]);

  const hash = crypto.createHmac('sha256', secret).update(dataBuffer).digest();

  // Dynamic truncation (RFC 4226) — big-endian assembly of 4 bytes.
  const offset = hash[hash.length - 1] & 0x0f;
  const binCode =
    ((hash[offset] & 0x7f) << 24) |
    ((hash[offset + 1] & 0xff) << 16) |
    ((hash[offset + 2] & 0xff) << 8) |
    (hash[offset + 3] & 0xff);

  return (binCode % 1000000).toString().padStart(6, '0');
}

/**
 * ECDSA P-256 / SHA-256 signature of `data`, returned as base64 DER. The device
 * private key is passed explicitly as a node KeyObject (the reference used a
 * module-global `ecKeyPair`). ECDSA signing is non-deterministic (random k), so
 * the output cannot be golden-compared byte-for-byte — verify with the matching
 * public key instead.
 */
export function ecSign(
  data: string,
  devicePrivateKey: crypto.KeyObject,
): string {
  const sign = crypto.createSign('SHA256');
  sign.update(data);
  sign.end();
  return sign.sign(devicePrivateKey).toString('base64');
}

/** MD5 of the lowercased URL, hex — port of `computeXSU`. */
export function computeXSU(url: string): string {
  return crypto.createHash('md5').update(url.toLowerCase()).digest('hex');
}

/**
 * Builds the exact X-Sign signing-input string: header values concatenated in
 * `xshList` order. The `url` token is replaced by `pathname + search` of the URL
 * (falling back to the raw url if it does not parse). Factored out of
 * `computeXSign` so the deterministic signing payload can be golden-pinned even
 * though the resulting ECDSA signature is non-deterministic.
 */
export function buildXSignInput(
  url: string,
  headers: Record<string, string>,
  xshList: string,
): string {
  const parts = xshList.split(',').map((name) => {
    if (name === 'url') {
      try {
        const u = new URL(url);
        return u.pathname + u.search;
      } catch {
        return url;
      }
    }
    return headers[name] || '';
  });
  return parts.join('');
}

/**
 * Computes the `X-Sign` header: ECDSA signature (base64) over the concatenated
 * signing input. Port of `computeXSign` with the device key passed explicitly.
 */
export function computeXSign(
  url: string,
  headers: Record<string, string>,
  xshList: string,
  devicePrivateKey: crypto.KeyObject,
): string {
  return ecSign(buildXSignInput(url, headers, xshList), devicePrivateKey);
}
