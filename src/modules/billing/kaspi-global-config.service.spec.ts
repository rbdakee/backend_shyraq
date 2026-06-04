import {
  KaspiGlobalConfig,
  KaspiGlobalConfigPatch,
} from './domain/kaspi-global-config';
import { KaspiGlobalConfigRepository } from './infrastructure/persistence/kaspi-global-config.repository';
import { KaspiGlobalConfigService } from './kaspi-global-config.service';

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
  getCalls = 0;
  updateCalls = 0;
  /** When > 0, the next `get()` call(s) reject (simulating a transient DB blip). */
  failNextGetCount = 0;

  reset(overrides?: Partial<KaspiGlobalConfig>): void {
    this.row = { ...BASE_CONFIG, ...overrides };
    this.getCalls = 0;
    this.updateCalls = 0;
    this.failNextGetCount = 0;
  }

  get(): Promise<KaspiGlobalConfig> {
    this.getCalls++;
    if (this.failNextGetCount > 0) {
      this.failNextGetCount--;
      return Promise.reject(new Error('transient_db_blip'));
    }
    return Promise.resolve({ ...this.row });
  }

  update(
    patch: KaspiGlobalConfigPatch,
    updatedBy: string,
  ): Promise<KaspiGlobalConfig> {
    this.updateCalls++;
    this.row = {
      ...this.row,
      ...patch,
      updatedBy,
      updatedAt: new Date(),
    };
    return Promise.resolve({ ...this.row });
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('KaspiGlobalConfigService', () => {
  let repo: FakeKaspiGlobalConfigRepo;
  let svc: KaspiGlobalConfigService;

  beforeEach(() => {
    repo = new FakeKaspiGlobalConfigRepo();
    svc = new KaspiGlobalConfigService(repo);
  });

  describe('getConfig()', () => {
    it('returns the config from the repo on first call', async () => {
      const cfg = await svc.getConfig();
      expect(cfg.appBuild).toBe('1076');
      expect(repo.getCalls).toBe(1);
    });

    it('returns cached value on second call without hitting the repo again', async () => {
      await svc.getConfig();
      await svc.getConfig();
      expect(repo.getCalls).toBe(1);
    });

    it('recovers after a rejected first load (does not permanently poison the cache)', async () => {
      // First load rejects (transient DB blip).
      repo.failNextGetCount = 1;
      await expect(svc.getConfig()).rejects.toThrow('transient_db_blip');

      // Second call must retry the repo and succeed — the loadingPromise was
      // reset on rejection rather than cached forever.
      const cfg = await svc.getConfig();
      expect(cfg.appBuild).toBe('1076');
      expect(repo.getCalls).toBe(2);
    });

    it('collapses concurrent cache-miss callers into a single repo.get call', async () => {
      const [a, b, c] = await Promise.all([
        svc.getConfig(),
        svc.getConfig(),
        svc.getConfig(),
      ]);
      expect(repo.getCalls).toBe(1);
      expect(a.appBuild).toBe('1076');
      expect(b.appBuild).toBe('1076');
      expect(c.appBuild).toBe('1076');
    });
  });

  describe('update()', () => {
    it('writes the patch via repo', async () => {
      await svc.update({ appBuild: '1077' }, 'user-uuid');
      expect(repo.updateCalls).toBe(1);
    });

    it('returns the updated config', async () => {
      const updated = await svc.update({ appBuild: '1077' }, 'user-uuid');
      expect(updated.appBuild).toBe('1077');
      expect(updated.updatedBy).toBe('user-uuid');
    });

    it('invalidates the cache so subsequent getConfig re-reads are served from cache (updated value)', async () => {
      // Prime cache with old value
      await svc.getConfig();
      expect(repo.getCalls).toBe(1);

      // Update — repo.get is NOT called again (update returns fresh value)
      await svc.update({ appBuild: '1077' }, 'user-uuid');
      expect(repo.getCalls).toBe(1);

      // Subsequent getConfig returns the new cached value without another repo.get
      const afterUpdate = await svc.getConfig();
      expect(afterUpdate.appBuild).toBe('1077');
      expect(repo.getCalls).toBe(1); // still 1 — update populated the cache
    });

    it('forces a repo.get on next getConfig after update + invalidate', async () => {
      await svc.getConfig();
      expect(repo.getCalls).toBe(1);

      await svc.update({ appBuild: '1077' }, 'user-uuid');
      svc.invalidate(); // explicit invalidation clears the post-update cache

      await svc.getConfig();
      expect(repo.getCalls).toBe(2);
    });
  });

  describe('invalidate()', () => {
    it('forces repo.get on next getConfig call', async () => {
      await svc.getConfig();
      expect(repo.getCalls).toBe(1);

      svc.invalidate();

      await svc.getConfig();
      expect(repo.getCalls).toBe(2);
    });

    it('does not throw when called before any getConfig call', () => {
      expect(() => svc.invalidate()).not.toThrow();
    });
  });
});
