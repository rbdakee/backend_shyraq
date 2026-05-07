import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { InvoiceRepository } from '../../invoice.repository';

/**
 * Relational impl of `InvoiceRepository`. T3 implements only the advisory
 * lock; T4 will add CRUD methods, mapper wiring, and `@InjectRepository`
 * for the TypeORM entity (which doesn't exist yet — declared in T4).
 *
 * The lock method needs only the ambient `EntityManager` — no entity-
 * specific repository — so it works without `forFeature` registration in
 * T3.
 */
@Injectable()
export class InvoiceRelationalRepository extends InvoiceRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  /**
   * `pg_advisory_xact_lock(hashtext('billing:monthly:'||kgId||':'||YYYY-MM)::bigint)`.
   * Released on TX commit / rollback. Goes through `manager()` so it joins
   * the ambient HTTP TX (set up by `TenantContextInterceptor`) — no
   * explicit TX-bracketing needed at this layer.
   *
   * `periodStart` is normalised to its UTC `YYYY-MM` prefix so a 02:00
   * Asia/Almaty cron firing on `2026-06-01T20:00:00Z` (= local 2026-06-02
   * 02:00) and a same-period 23:59 manual trigger lock on the same key —
   * monthly cron generates one period per (kg, year-month).
   */
  async acquireMonthlyGenerationAdvisoryLock(
    kindergartenId: string,
    periodStart: Date,
  ): Promise<void> {
    const periodKey = periodStart.toISOString().slice(0, 7);
    const scope = `billing:monthly:${kindergartenId}:${periodKey}`;
    await this.manager().query(
      `SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`,
      [scope],
    );
  }

  /**
   * Selects the EntityManager bound to the active tenant transaction (set
   * by `TenantContextInterceptor`) when present, otherwise falls back to
   * the DataSource's default pool manager. Mirrors identity-qr / pickup.
   */
  private manager(): EntityManager {
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.dataSource.manager;
  }
}
