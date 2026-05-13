import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { MoneyKzt } from '@/shared-kernel/domain/money-kzt';
import { Refund } from '../../../../domain/entities/refund.entity';
import { ListRefundsFilter, RefundRepository } from '../../refund.repository';
import { RefundTypeOrmEntity } from '../entities/refund.typeorm.entity';
import { RefundMapper } from '../mappers/refund.mapper';

/**
 * Relational impl of `RefundRepository`. Mirrors `payment.relational.repository`
 * style: `manager()` resolves the ambient tenant manager from
 * `tenantStorage` so the per-request `SET LOCAL app.kindergarten_id` GUC
 * remains in effect for RLS, falls back to the pool when called outside a
 * request (CLI / tests).
 *
 * State-flips use conditional UPDATE WHERE status=expected RETURNING *
 * (db8cb72 pattern) so a concurrent flip is a no-op (`null` return).
 */
@Injectable()
export class RefundRelationalRepository extends RefundRepository {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(RefundTypeOrmEntity)
    private readonly repo: Repository<RefundTypeOrmEntity>,
  ) {
    super();
  }

  private manager(explicit?: EntityManager): EntityManager {
    if (explicit) return explicit;
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.dataSource.manager;
  }

  async create(refund: Refund, explicit?: EntityManager): Promise<Refund> {
    const m = this.manager(explicit);
    const s = refund.toState();
    await m.getRepository(RefundTypeOrmEntity).insert({
      id: s.id,
      kindergartenId: s.kindergartenId,
      paymentId: s.paymentId,
      invoiceId: s.invoiceId,
      amount: s.amount,
      reason: s.reason,
      status: s.status,
      processedBy: s.processedBy,
      providerRef: s.providerRef,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    });
    return refund;
  }

  async findById(kindergartenId: string, id: string): Promise<Refund | null> {
    const row = await this.manager()
      .getRepository(RefundTypeOrmEntity)
      .findOne({ where: { id, kindergartenId } });
    return row ? RefundMapper.toDomain(row) : null;
  }

  async findByPaymentId(
    kindergartenId: string,
    paymentId: string,
  ): Promise<Refund[]> {
    const rows = await this.manager()
      .getRepository(RefundTypeOrmEntity)
      .find({
        where: { kindergartenId, paymentId },
        order: { createdAt: 'DESC' },
      });
    return rows.map(RefundMapper.toDomain);
  }

  async list(
    kindergartenId: string,
    filter: ListRefundsFilter = {},
  ): Promise<Refund[]> {
    const qb = this.manager()
      .getRepository(RefundTypeOrmEntity)
      .createQueryBuilder('r')
      .where('r.kindergarten_id = :kg', { kg: kindergartenId });

    if (filter.status) {
      qb.andWhere('r.status = :status', { status: filter.status });
    }
    if (filter.paymentId) {
      qb.andWhere('r.payment_id = :payment', { payment: filter.paymentId });
    }
    if (filter.fromDate) {
      qb.andWhere('r.created_at >= :from', { from: filter.fromDate });
    }
    if (filter.toDate) {
      qb.andWhere('r.created_at <= :to', { to: filter.toDate });
    }
    qb.orderBy('r.created_at', 'DESC').addOrderBy('r.id', 'DESC');

    const rows = await qb.getMany();
    return rows.map(RefundMapper.toDomain);
  }

  async markApprovedConditional(
    kindergartenId: string,
    id: string,
    processedBy: string,
    now: Date,
  ): Promise<Refund | null> {
    return this.transitionConditional(kindergartenId, id, ['pending'], {
      status: 'approved',
      processedBy,
      updatedAt: now,
    });
  }

  async markRejectedConditional(
    kindergartenId: string,
    id: string,
    reason: string,
    now: Date,
  ): Promise<Refund | null> {
    return this.transitionConditional(kindergartenId, id, ['pending'], {
      status: 'rejected',
      reason,
      updatedAt: now,
    });
  }

  async markProcessedConditional(
    kindergartenId: string,
    id: string,
    providerRef: string | null,
    now: Date,
  ): Promise<Refund | null> {
    return this.transitionConditional(kindergartenId, id, ['approved'], {
      status: 'processed',
      providerRef,
      updatedAt: now,
    });
  }

  async acquireRefundProcessAdvisoryLock(
    kindergartenId: string,
    refundId: string,
  ): Promise<void> {
    const scope = `billing:refund:${kindergartenId}:${refundId}`;
    await this.manager().query(
      `SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`,
      [scope],
    );
  }

  // ── B21 T3 ProRataRefundProcessor helpers ─────────────────────────────

  async acquireProRataAdvisoryLock(
    kindergartenId: string,
    childId: string,
  ): Promise<void> {
    const scope = `billing:pro-rata:${kindergartenId}:${childId}`;
    await this.manager().query(
      `SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`,
      [scope],
    );
  }

  async findPendingProRataForChildSinceArchive(
    kindergartenId: string,
    childId: string,
    since: Date,
  ): Promise<Refund[]> {
    // Join refunds → invoices to filter by child_id; refund has no
    // child_id column. Filter `reason = 'pro_rata_archive'` to scope
    // strictly to lifecycle-issued rows so an admin-created refund on
    // the same invoice does not silently make this look like a duplicate.
    const m = this.manager();
    const rows = (await m.query(
      `SELECT r.*
         FROM refunds r
         JOIN invoices i ON i.id = r.invoice_id
        WHERE r.kindergarten_id = $1
          AND i.child_id = $2
          AND r.reason = 'pro_rata_archive'
          AND r.created_at >= $3
        ORDER BY r.created_at DESC`,
      [kindergartenId, childId, since],
    )) as Array<Record<string, unknown>>;
    return rows.map((raw) => {
      // The raw rows come from the driver in snake_case. Re-shape into
      // RefundTypeOrmEntity columns before handing to the mapper.
      const ent = m.getRepository(RefundTypeOrmEntity).create({
        id: raw.id as string,
        kindergartenId: raw.kindergarten_id as string,
        paymentId: raw.payment_id as string,
        invoiceId: (raw.invoice_id as string) ?? null,
        amount: MoneyKzt.fromString(String(raw.amount)),
        reason: raw.reason as string,
        status: raw.status as 'pending' | 'approved' | 'processed' | 'rejected',
        processedBy: (raw.processed_by as string) ?? null,
        providerRef: (raw.provider_ref as string) ?? null,
        createdAt: raw.created_at as Date,
        updatedAt: raw.updated_at as Date,
      });
      return RefundMapper.toDomain(ent);
    });
  }

  async getProcessedRefundsSumForInvoice(
    kindergartenId: string,
    invoiceId: string,
  ): Promise<number> {
    const m = this.manager();
    const result = await m.query(
      `SELECT COALESCE(SUM(amount), 0)::text AS sum
         FROM refunds
        WHERE kindergarten_id = $1
          AND invoice_id = $2
          AND status = 'processed'`,
      [kindergartenId, invoiceId],
    );
    const sum = result?.[0]?.sum ?? '0';
    return Number(sum);
  }

  /**
   * Conditional UPDATE: applies `patch` only if current row status is one
   * of `expected`. Returns the hydrated domain on success or `null` when
   * 0 rows matched. Mirrors `PaymentRelationalRepository.transitionConditional`.
   */
  private async transitionConditional(
    kindergartenId: string,
    id: string,
    expected: Array<'pending' | 'approved' | 'processed' | 'rejected'>,
    patch: Partial<RefundTypeOrmEntity>,
  ): Promise<Refund | null> {
    const m = this.manager();
    const result = await m
      .createQueryBuilder()
      .update(RefundTypeOrmEntity)
      .set(patch)
      .where('id = :id', { id })
      .andWhere('kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere('status IN (:...expected)', { expected })
      .returning('*')
      .execute();

    if (!result.raw?.length) {
      return null;
    }

    const row = await m
      .getRepository(RefundTypeOrmEntity)
      .findOne({ where: { id, kindergartenId } });
    return row ? RefundMapper.toDomain(row) : null;
  }
}
