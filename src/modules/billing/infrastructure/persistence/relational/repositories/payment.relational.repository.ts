import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { PaymentRepository } from '../../payment.repository';

/**
 * Relational impl of `PaymentRepository`. T3 implements only the advisory
 * lock; T5 will add CRUD + state-flip methods alongside the TypeORM
 * entity + mapper.
 */
@Injectable()
export class PaymentRelationalRepository extends PaymentRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  /**
   * `pg_advisory_xact_lock(hashtext('billing:payment:'||kgId||':'||invoiceId)::bigint)`.
   * Released on TX commit / rollback. Goes through `manager()` so it
   * inherits the ambient TX from `TenantContextInterceptor` (parent-pay
   * path) or the per-event `BEGIN` of the webhook controller (T5a).
   */
  async acquirePaymentAdvisoryLock(
    kindergartenId: string,
    invoiceId: string,
  ): Promise<void> {
    const scope = `billing:payment:${kindergartenId}:${invoiceId}`;
    await this.manager().query(
      `SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`,
      [scope],
    );
  }

  private manager(): EntityManager {
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.dataSource.manager;
  }
}
