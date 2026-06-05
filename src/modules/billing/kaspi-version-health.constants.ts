/**
 * Shared constants for the K9 Kaspi version-gate health cron.
 *
 * Kept in a standalone, dependency-free file so that consumers (e.g.
 * `HealthService` in the health module) can import the Redis key WITHOUT
 * pulling in `KaspiVersionHealthService` and its transitive Kaspi-HTTP deps.
 * This prevents a HealthModule → BillingModule import cycle.
 */

/** Redis key holding the cached version-gate health snapshot (JSON). */
export const KASPI_VERSION_HEALTH_REDIS_KEY = 'kaspi:version_health';

/**
 * Snapshot shape written by the cron and read by `/health/ready`.
 * `checkedAt` is an ISO-8601 timestamp.
 */
export interface KaspiVersionHealthSnapshot {
  build: string;
  accepted: boolean;
  alarm: string | null;
  checkedAt: string;
}
