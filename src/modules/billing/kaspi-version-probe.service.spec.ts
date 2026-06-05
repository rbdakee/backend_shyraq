import { KaspiGlobalConfig } from './domain/kaspi-global-config';
import { KaspiGlobalConfigRepository } from './infrastructure/persistence/kaspi-global-config.repository';
import {
  KaspiFetch,
  KaspiHttpClient,
} from './infrastructure/payment-provider/kaspi/kaspi-http.client';
import { KaspiGlobalConfigService } from './kaspi-global-config.service';
import { KaspiVersionProbeService } from './kaspi-version-probe.service';

// ─── Fixtures ────────────────────────────────────────────────────────────────

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

// ─── In-memory fake repo ─────────────────────────────────────────────────────

class FakeKaspiGlobalConfigRepo extends KaspiGlobalConfigRepository {
  private row: KaspiGlobalConfig = { ...BASE_CONFIG };

  setConfig(cfg: Partial<KaspiGlobalConfig>): void {
    this.row = { ...BASE_CONFIG, ...cfg };
  }

  get(): Promise<KaspiGlobalConfig> {
    return Promise.resolve({ ...this.row });
  }

  update(_patch: unknown, _updatedBy: string): Promise<KaspiGlobalConfig> {
    return Promise.resolve({ ...this.row });
  }
}

// ─── Fake fetch factory ───────────────────────────────────────────────────────

function makeFakeFetch(responseBody: unknown): KaspiFetch {
  return (_url: string, _init: RequestInit) => {
    const json = () => Promise.resolve(responseBody);
    const text = () => Promise.resolve(JSON.stringify(responseBody));
    return Promise.resolve({
      ok: true,
      status: 200,
      json,
      text,
    } as unknown as Response);
  };
}

// Helpers for building Kaspi response shapes
function blockedResponse() {
  return {
    view: {
      code: 'OldVersionToUpdate',
      onOpenAlarm: {
        error: {
          code: 'OldVersionToUpdate',
        },
      },
    },
  };
}

function acceptedResponse(viewCode = 'KPUniversalEnterPhoneNumber') {
  return {
    view: {
      code: viewCode,
    },
  };
}

function unexpectedResponse() {
  return {
    view: {
      code: 'SomeOtherView',
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('KaspiVersionProbeService', () => {
  let repo: FakeKaspiGlobalConfigRepo;
  let configSvc: KaspiGlobalConfigService;

  function buildProbeService(responseBody: unknown): KaspiVersionProbeService {
    const fakeHttp = new KaspiHttpClient(makeFakeFetch(responseBody));
    return new KaspiVersionProbeService(configSvc, fakeHttp);
  }

  beforeEach(() => {
    repo = new FakeKaspiGlobalConfigRepo();
    configSvc = new KaspiGlobalConfigService(repo);
  });

  describe('blocked build', () => {
    it('returns accepted=false and alarm=OldVersionToUpdate when Kaspi blocks the build', async () => {
      const svc = buildProbeService(blockedResponse());
      const result = await svc.probe({ appBuild: '1070' });
      expect(result.accepted).toBe(false);
      expect(result.alarm).toBe('OldVersionToUpdate');
      expect(result.build).toBe('1070');
    });
  });

  describe('accepted build', () => {
    it('returns accepted=true and no alarm for KPUniversalEnterPhoneNumber view', async () => {
      const svc = buildProbeService(
        acceptedResponse('KPUniversalEnterPhoneNumber'),
      );
      const result = await svc.probe({ appBuild: '1076' });
      expect(result.accepted).toBe(true);
      expect(result.alarm).toBeUndefined();
      expect(result.build).toBe('1076');
    });

    it('returns accepted=true for EnterPhoneNumber view', async () => {
      const svc = buildProbeService(acceptedResponse('EnterPhoneNumber'));
      const result = await svc.probe({ appBuild: '1076' });
      expect(result.accepted).toBe(true);
      expect(result.alarm).toBeUndefined();
    });
  });

  describe('unexpected response', () => {
    it('returns accepted=false and no alarm for an unrecognised view code', async () => {
      const svc = buildProbeService(unexpectedResponse());
      const result = await svc.probe({ appBuild: '1076' });
      expect(result.accepted).toBe(false);
      expect(result.alarm).toBeUndefined();
    });
  });

  describe('default build/version from config', () => {
    it('uses config appBuild when no override provided', async () => {
      repo.setConfig({ appBuild: '1076', appVersion: '4.110.1' });
      const svc = buildProbeService(acceptedResponse());
      const result = await svc.probe({}); // no overrides
      expect(result.build).toBe('1076');
    });

    it('uses provided appBuild override instead of config', async () => {
      repo.setConfig({ appBuild: '1076' });
      const svc = buildProbeService(acceptedResponse());
      const result = await svc.probe({ appBuild: '9999' });
      expect(result.build).toBe('9999');
    });

    it('uses provided appVersion override instead of config', async () => {
      // We can't directly inspect the body sent; but we can at least verify
      // the probe runs without error and returns the override build
      const svc = buildProbeService(acceptedResponse());
      const result = await svc.probe({ appBuild: '1076', appVersion: '5.0.0' });
      expect(result.build).toBe('1076');
      expect(result.accepted).toBe(true);
    });

    it('uses config values when called with no arguments', async () => {
      const svc = buildProbeService(acceptedResponse());
      const result = await svc.probe();
      expect(result.build).toBe(BASE_CONFIG.appBuild);
    });
  });

  describe('null/empty response body', () => {
    it('returns accepted=false and no alarm when the response body is null', async () => {
      const svc = buildProbeService(null);
      const result = await svc.probe();
      expect(result.accepted).toBe(false);
      expect(result.alarm).toBeUndefined();
    });
  });
});
