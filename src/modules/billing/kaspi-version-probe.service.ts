import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { KaspiHttpClient } from './infrastructure/payment-provider/kaspi/kaspi-http.client';
import { KaspiGlobalConfigService } from './kaspi-global-config.service';

export interface KaspiVersionProbeInput {
  /** Override the app_build from config. Defaults to config value. */
  appBuild?: string;
  /** Override the app_version from config. Defaults to config value. */
  appVersion?: string;
}

export interface KaspiVersionProbeResult {
  /** The app_build string that was probed. */
  build: string;
  /** True if Kaspi's gate accepted the build (phone-entry view appeared). */
  accepted: boolean;
  /** Present only when the build is actively blocked by Kaspi. */
  alarm?: 'OldVersionToUpdate';
}

/**
 * KaspiVersionProbeService — SMS-free version-gate health-check.
 *
 * Replicates `kaspi_pay_test/e2e/version-probe.mjs` EXACTLY:
 *   POST ${entranceUrl}/api/v1/entrance/step
 *   Inspects `view.onOpenAlarm.error.code` for `OldVersionToUpdate` and
 *   `view.code` for `KPUniversalEnterPhoneNumber` | `EnterPhoneNumber`.
 *
 * The probe is device-independent for gate purposes — Kaspi's gate fires on
 * `app_build` BEFORE any device validation. Per HANDOFF A5:
 *   - We generate ephemeral random deviceId/installId (UUID uppercased) for
 *     each probe. They are NOT persisted.
 *   - `pk` is a base64-encoded 65-byte uncompressed EC point placeholder;
 *     `pkTag` is the md5 hex of pk. The gate ignores them at this step.
 * TODO: if Kaspi begins device-fingerprint checks at the init step, replace
 * ephemeral ids with a stored probe-device identity (similar to config.js).
 */
@Injectable()
export class KaspiVersionProbeService {
  constructor(
    private readonly configService: KaspiGlobalConfigService,
    private readonly http: KaspiHttpClient,
  ) {}

  async probe(
    input: KaspiVersionProbeInput = {},
  ): Promise<KaspiVersionProbeResult> {
    const cfg = await this.configService.getConfig();

    const appBuild = input.appBuild ?? cfg.appBuild;
    const appVersion = input.appVersion ?? cfg.appVersion;

    // Ephemeral device identity — NOT persisted. The gate only checks
    // app_build at this step (entrance/step init), not device fingerprint.
    // See HANDOFF A5 for rationale.
    const deviceId = randomUUID().toUpperCase();
    const installId = randomUUID().toUpperCase();

    // Placeholder pk / pkTag:
    //   pk  = base64 of 65 zero-bytes (uncompressed EC point placeholder)
    //   pkTag = md5 hex of the pk string
    // The gate ignores these at the init step per empirical testing.
    const pk = Buffer.alloc(65).toString('base64');
    const pkTag = createHash('md5').update(pk).digest('hex');

    // Cookie string matches version-probe.mjs byte-for-byte.
    // ma_platform_type uses APP.platform = 'iOS' (cookie value).
    // Body platformType = 'IOS' (uppercase, matches the mjs body field).
    const cookie =
      `deviceId=${deviceId}; installId=${installId}; is_mobile_app=true; ` +
      `locale=ru-RU; ma_bld=${appBuild}; ma_platform_type=iOS; ` +
      `ma_platform_ver=${cfg.platformVer}; ma_ver=${appVersion}; pk=${pk}; ` +
      `pkTag=${pkTag}; xs=R:0|E:0|RH:0|N:0`;

    const headers: Record<string, string> = {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'Accept-Language': 'ru',
      Origin: cfg.entranceUrl,
      'User-Agent': cfg.uaBrowser,
      Cookie: cookie,
    };

    const body = {
      data: {},
      Data: {
        auth: '2',
        appBuild,
        appVersion,
        platformVersion: cfg.platformVer,
        platformType: 'IOS',
        deviceBrand: cfg.brand,
        deviceModel: cfg.model,
        deviceId,
        installId,
        frontCameraAvailable: 'true',
        sf: 'registration',
        pc: 'KPEntrance',
        noPass: '0',
      },
      actType: 'Success',
    };

    const { json } = await this.http.request(
      'POST',
      `${cfg.entranceUrl}/api/v1/entrance/step`,
      { headers, body },
    );

    // Parse response — mirrors version-probe.mjs lines 51-54
    const view = (json as Record<string, unknown> | null)?.['view'] as
      | Record<string, unknown>
      | undefined;
    const alarmCode = (
      (view?.['onOpenAlarm'] as Record<string, unknown> | undefined)?.[
        'error'
      ] as Record<string, unknown> | undefined
    )?.['code'] as string | undefined;
    const viewCode = view?.['code'] as string | undefined;

    const blocked = alarmCode === 'OldVersionToUpdate';
    const accepted =
      !blocked &&
      (viewCode === 'KPUniversalEnterPhoneNumber' ||
        viewCode === 'EnterPhoneNumber');

    return {
      build: appBuild,
      accepted,
      ...(blocked ? { alarm: 'OldVersionToUpdate' as const } : {}),
    };
  }
}
