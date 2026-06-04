import { Injectable } from '@nestjs/common';
import {
  KaspiGlobalConfig,
  KaspiGlobalConfigPatch,
} from './domain/kaspi-global-config';
import { KaspiGlobalConfigRepository } from './infrastructure/persistence/kaspi-global-config.repository';

/**
 * KaspiGlobalConfigService — single read-point for Kaspi global config.
 *
 * Holds an in-memory cached copy of the singleton `kaspi_global_config` row.
 * K5 (onboarding adapter) and K6 (payment adapter) inject this service to get
 * the app version, build, URLs, and UA strings without hitting the DB on every
 * Kaspi API call.
 *
 * Cache strategy:
 *   - Lazy-load on first `getConfig()` call.
 *   - `update()` writes via repo, then invalidates + reloads.
 *   - `invalidate()` clears the cache so the next `getConfig()` reloads.
 *   - Simple field cache (no TTL, no stampede protection beyond a loading
 *     promise) is intentional — this table changes at human-admin cadence
 *     (infrequent), not at request cadence.
 *
 * Concurrent callers: a `loadingPromise` field collapses concurrent misses
 * into one DB round-trip, preventing thundering-herd on the first request.
 */
@Injectable()
export class KaspiGlobalConfigService {
  private cached: KaspiGlobalConfig | null = null;
  /**
   * In-flight load promise shared between concurrent callers during a cache
   * miss. Null when no load is in progress.
   */
  private loadingPromise: Promise<KaspiGlobalConfig> | null = null;

  constructor(private readonly repo: KaspiGlobalConfigRepository) {}

  /**
   * Returns the cached config; lazy-loads from the DB on first call or after
   * invalidation. Concurrent callers during a miss share the same DB promise.
   */
  async getConfig(): Promise<KaspiGlobalConfig> {
    if (this.cached !== null) {
      return this.cached;
    }

    if (this.loadingPromise !== null) {
      return this.loadingPromise;
    }

    this.loadingPromise = this.repo
      .get()
      .then((cfg) => {
        this.cached = cfg;
        this.loadingPromise = null;
        return cfg;
      })
      .catch((err) => {
        // Reset so a transient DB failure does not permanently poison the
        // cache — the next caller retries the load instead of re-receiving
        // this same rejected promise.
        this.loadingPromise = null;
        throw err;
      });

    return this.loadingPromise;
  }

  /**
   * Applies a partial patch via the repo, then invalidates and reloads the
   * cache. Returns the freshly-loaded config after the write.
   */
  async update(
    patch: KaspiGlobalConfigPatch,
    updatedBy: string,
  ): Promise<KaspiGlobalConfig> {
    const updated = await this.repo.update(patch, updatedBy);
    // Invalidate and store the freshly-returned value.
    this.cached = updated;
    this.loadingPromise = null;
    return updated;
  }

  /**
   * Clears the in-memory cache. The next `getConfig()` call will reload from
   * the DB. Used by cron jobs or external triggers to force a refresh.
   */
  invalidate(): void {
    this.cached = null;
    this.loadingPromise = null;
  }
}
