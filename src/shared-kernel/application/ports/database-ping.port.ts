/**
 * DatabasePingPort — tiny health-probe abstraction used by `HealthService`
 * so the readiness check can run without importing `DataSource` from
 * `'typeorm'` directly in the service. The relational adapter issues a
 * `SELECT 1` against the default connection and resolves on success;
 * connection errors propagate so the caller maps them to `'down'`.
 */
export abstract class DatabasePingPort {
  abstract ping(): Promise<void>;
}
