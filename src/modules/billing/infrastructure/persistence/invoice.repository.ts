/**
 * Persistence port for the Invoice aggregate (B13).
 *
 * T3 declares only the advisory-lock method needed by the monthly billing
 * processor. Full CRUD + state-flip methods (`create`, `findById`,
 * `listByKindergarten`, conditional-UPDATE `markPaid` / `cancel`, etc.) are
 * added in T4 alongside the TypeORM entity + mapper.
 *
 * Tenant-scoped: the relational impl participates in the ambient tenant TX
 * established by `TenantContextInterceptor`, so RLS filters rows
 * automatically.
 */
export abstract class InvoiceRepository {
  /**
   * Acquires `pg_advisory_xact_lock(hashtext('billing:monthly:'||kgId||':'||YYYY-MM))`.
   * Released automatically when the surrounding TX commits or rolls back.
   *
   * Used by the monthly-billing processor (T4b) to serialise concurrent
   * generation runs for the same `(kindergartenId, periodStart)`. Without
   * the lock two parallel cron firings (BullMQ retry, manual super-admin
   * trigger overlapping with the scheduled run) could each iterate the
   * same set of `tariff_assignments` and double-insert invoices.
   *
   * MUST be called inside an ambient TX — outside one Postgres releases
   * the lock at the implicit per-statement boundary, which makes the call
   * a no-op. Safe for CLI / non-HTTP code paths (those don't race).
   */
  abstract acquireMonthlyGenerationAdvisoryLock(
    kindergartenId: string,
    periodStart: Date,
  ): Promise<void>;
}
