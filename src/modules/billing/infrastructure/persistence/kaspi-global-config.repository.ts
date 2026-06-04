import {
  KaspiGlobalConfig,
  KaspiGlobalConfigPatch,
} from '../../domain/kaspi-global-config';

/**
 * Persistence port for `kaspi_global_config`.
 *
 * Single-row global table (id = 1). NOT tenant-scoped — callers do NOT pass
 * a kindergartenId. The row is guaranteed to exist (seeded by the B24
 * migration); `get()` throws if somehow missing.
 *
 * Note on manager() usage: Although this table has NO RLS, the relational
 * implementation still uses the manager() helper (tenantStorage fallback to
 * this.repo.manager) for consistency with the rest of the codebase. For reads
 * outside HTTP pipelines (cron, CLI, integration tests) the fallback to
 * this.repo.manager is used automatically.
 */
export abstract class KaspiGlobalConfigRepository {
  /**
   * Returns the singleton config row (id = 1).
   * Throws `kaspi_global_config_missing` if the seed row is absent
   * (indicates a DB bootstrap failure — should never happen in production).
   */
  abstract get(): Promise<KaspiGlobalConfig>;

  /**
   * Applies a partial patch to the singleton row (id = 1), sets
   * `updated_by = updatedBy` and `updated_at = now()`, then returns the
   * updated config.
   */
  abstract update(
    patch: KaspiGlobalConfigPatch,
    updatedBy: string,
  ): Promise<KaspiGlobalConfig>;
}
