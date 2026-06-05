import * as crypto from 'crypto';
import { QRPAY_XSH, buildXSignInput } from './kaspi-crypto';
import {
  KaspiAppConfig,
  KaspiDeviceIdentity,
  KaspiSession,
  signedQrPayHeaders,
} from './kaspi-signed-headers';

/**
 * Ties the header-assembly to the golden signing payload from kaspi-crypto.spec.
 * The X-SH order and every injected field value are pinned; X-Sign is verified
 * against the device public key rather than byte-compared (ECDSA is
 * non-deterministic).
 */

const FIXED_URL =
  'https://qrpay.kaspi.kz/qrpay/v02/remote/details?operationId=12345';

const GOLDEN = {
  MAC: '763293',
  XSH: 'url,X-Request-ID,X-Device-ID,X-Platform-Ver,X-App-Bld,X-Time,X-Kb-TokenSn,X-App-Ver,X-Kb-TokenSnMac,X-Call,X-PI,X-Install-ID,X-Platform-Type,X-Locale,X-SV',
  XSIGN_INPUT:
    '/qrpay/v02/remote/details?operationId=12345AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEEDEVICE-AAAA-BBBB-CCCC18.510762026-06-04T19:00:00.123+05:00TESTTOKEN123456784.110.1763293notConnected987INSTALL-1111-2222-3333iOSru-RU2',
};

const DEVICE_PRIV_B64 =
  'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgwyS1jLl2F+E9yucJNsj4L+ATzbg8t/hQbDzeV8ohcxqhRANCAARv9kFObcHxHydp75nvAJ0+E4/Nyn+ILtpIdFwYXxaQ1hI+wpWyV/IoPb67qVawpz+4uFpnVV9AfuB3G47qsnqy';
const DEVICE_PUB_B64 =
  'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEb/ZBTm3B8R8nae+Z7wCdPhOPzcp/iC7aSHRcGF8WkNYSPsKVslfyKD2+u6lWsKc/uLhaZ1VfQH7gdxuO6rJ6sg==';

const SECRET_HEX =
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

function makeArgs(): {
  session: KaspiSession;
  device: KaspiDeviceIdentity;
  app: KaspiAppConfig;
} {
  const privateKey = crypto.createPrivateKey({
    key: Buffer.from(DEVICE_PRIV_B64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  return {
    session: {
      tokenSN: 'TESTTOKEN12345678',
      decryptedSecret: Buffer.from(SECRET_HEX, 'hex'),
      profileId: 987,
    },
    device: {
      deviceId: 'DEVICE-AAAA-BBBB-CCCC',
      installId: 'INSTALL-1111-2222-3333',
      privateKey,
    },
    app: {
      version: '4.110.1',
      build: '1076',
      platform: 'iOS',
      platformVer: '18.5',
      locale: 'ru-RU',
      uaNative: 'Kaspi%20Pay/1076 CFNetwork/3826.500.131 Darwin/24.5.0',
    },
  };
}

const OVERRIDES = {
  requestId: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
  timeIso: '2026-06-04T19:00:00.123+05:00',
  nowMs: 1717500000000,
};

describe('signedQrPayHeaders', () => {
  it('assembles qrpay headers with the exact X-SH order and field values', () => {
    const { session, device, app } = makeArgs();
    const h = signedQrPayHeaders(FIXED_URL, session, device, app, OVERRIDES);

    expect(h['X-SH']).toBe(GOLDEN.XSH);
    expect(h['X-SH']).toBe(QRPAY_XSH);

    expect(h['X-Kb-TokenSn']).toBe('TESTTOKEN12345678');
    expect(h['X-Kb-TokenSnMac']).toBe(GOLDEN.MAC);
    expect(h['X-PI']).toBe('987');
    expect(h['X-Install-ID']).toBe('INSTALL-1111-2222-3333');
    expect(h['X-Device-ID']).toBe('DEVICE-AAAA-BBBB-CCCC');
    expect(h['X-App-Ver']).toBe('4.110.1');
    expect(h['X-App-Bld']).toBe('1076');
    expect(h['X-Platform-Type']).toBe('iOS');
    expect(h['X-Platform-Ver']).toBe('18.5');
    expect(h['X-Locale']).toBe('ru-RU');
    expect(h['X-Time']).toBe('2026-06-04T19:00:00.123+05:00');
    expect(h['X-Request-ID']).toBe('AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE');
    expect(h['X-Call']).toBe('notConnected');
    expect(h['X-SV']).toBe('2');
    expect(h['User-Agent']).toBe(
      'Kaspi%20Pay/1076 CFNetwork/3826.500.131 Darwin/24.5.0',
    );
    expect(h['Accept']).toBe('*/*');
    expect(h['Accept-Language']).toBe('ru');
    expect(h['Accept-Encoding']).toBe('gzip, deflate, br');
    expect(typeof h['X-Sign']).toBe('string');
    expect(h['X-Sign'].length).toBeGreaterThan(0);
  });

  it('reproduces the golden X-Sign signing input for pinned headers', () => {
    const { session, device, app } = makeArgs();
    const h = signedQrPayHeaders(FIXED_URL, session, device, app, OVERRIDES);
    const rebuilt = buildXSignInput(FIXED_URL, h, QRPAY_XSH);
    expect(rebuilt).toBe(GOLDEN.XSIGN_INPUT);
  });

  it('signs the assembled headers so X-Sign verifies against the device key', () => {
    const { session, device, app } = makeArgs();
    const h = signedQrPayHeaders(FIXED_URL, session, device, app, OVERRIDES);
    const publicKey = crypto.createPublicKey({
      key: Buffer.from(DEVICE_PUB_B64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    const input = buildXSignInput(FIXED_URL, h, QRPAY_XSH);
    const ok = crypto.verify(
      'SHA256',
      Buffer.from(input),
      publicKey,
      Buffer.from(h['X-Sign'], 'base64'),
    );
    expect(ok).toBe(true);
  });

  it('returns an empty X-PI when the session has no profileId', () => {
    const { session, device, app } = makeArgs();
    const h = signedQrPayHeaders(
      FIXED_URL,
      { ...session, profileId: null },
      device,
      app,
      OVERRIDES,
    );
    expect(h['X-PI']).toBe('');
  });
});
