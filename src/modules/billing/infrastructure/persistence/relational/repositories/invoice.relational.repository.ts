import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import {
  Invoice,
  InvoiceStatus,
} from '../../../../domain/entities/invoice.entity';
import { InvoiceLineItem } from '../../../../domain/entities/invoice-line-item.entity';
import {
  InvoiceRepository,
  ListInvoicesFilter,
} from '../../invoice.repository';
import { InvoiceTypeOrmEntity } from '../entities/invoice.typeorm.entity';
import { InvoiceLineItemTypeOrmEntity } from '../entities/invoice-line-item.typeorm.entity';
import { InvoiceMapper } from '../mappers/invoice.mapper';
import { toIsoDate } from '../mappers/date-utils';

@Injectable()
export class InvoiceRelationalRepository extends InvoiceRepository {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(InvoiceTypeOrmEntity)
    private readonly repo: Repository<InvoiceTypeOrmEntity>,
  ) {
    super();
  }

  /**
   * Resolve the working manager. Caller-supplied `manager` wins (used by
   * cron worker that opens its own TX), then `tenantStorage` (HTTP), then
   * default pool manager.
   */
  private manager(explicit?: EntityManager): EntityManager {
    if (explicit) return explicit;
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.dataSource.manager;
  }

  async create(
    invoice: Invoice,
    lineItems: InvoiceLineItem[],
    explicitManager?: EntityManager,
  ): Promise<Invoice> {
    const m = this.manager(explicitManager);
    const invoiceRepo = m.getRepository(InvoiceTypeOrmEntity);
    const lineItemRepo = m.getRepository(InvoiceLineItemTypeOrmEntity);
    const s = invoice.toState();

    await invoiceRepo.insert({
      id: s.id,
      kindergartenId: s.kindergartenId,
      childId: s.childId,
      paymentAccountId: s.paymentAccountId,
      tariffPlanId: s.tariffPlanId,
      invoiceType: s.invoiceType,
      periodStart: toIsoDate(s.periodStart),
      periodEnd: toIsoDate(s.periodEnd),
      amountDue: s.amountDue,
      discountPct: s.discountPct,
      discountReason: s.discountReason,
      amountAfterDiscount: s.amountAfterDiscount,
      status: s.status,
      dueDate: toIsoDate(s.dueDate),
      description: s.description,
      proratedForDays: s.proratedForDays,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    });

    if (lineItems.length > 0) {
      await lineItemRepo.insert(
        lineItems.map((li) => {
          const ls = li.toState();
          return {
            id: ls.id,
            invoiceId: ls.invoiceId,
            kindergartenId: ls.kindergartenId,
            description: ls.description,
            tariffPlanId: ls.tariffPlanId,
            quantity: ls.quantity,
            unitPrice: ls.unitPrice,
            lineTotal: ls.lineTotal,
            createdAt: ls.createdAt,
          };
        }),
      );
    }

    return invoice;
  }

  async findById(kindergartenId: string, id: string): Promise<Invoice | null> {
    const row = await this.manager()
      .getRepository(InvoiceTypeOrmEntity)
      .findOne({ where: { id, kindergartenId } });
    return row ? InvoiceMapper.toDomain(row) : null;
  }

  /**
   * Cross-tenant lookup by id only. Runs inside a short transaction with
   * `app.bypass_rls=true` — mirrors `ChildGuardianRelationalRepository`'s
   * cross-tenant methods. The caller (parent-side `InvoiceAccessGuard`) pins
   * the resolved kg onto `req.tenant` and lets the service re-check
   * guardian-of-child in that kg, so this read never leaks an invoice the
   * caller is not authorised to see.
   */
  override async findByIdCrossTenant(id: string): Promise<Invoice | null> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query(`SET LOCAL app.bypass_rls = 'true'`);
      const row = await manager
        .getRepository(InvoiceTypeOrmEntity)
        .findOne({ where: { id } });
      return row ? InvoiceMapper.toDomain(row) : null;
    });
  }

  async list(
    kindergartenId: string,
    filter: ListInvoicesFilter,
  ): Promise<Invoice[]> {
    const qb = this.manager()
      .getRepository(InvoiceTypeOrmEntity)
      .createQueryBuilder('inv')
      .where('inv.kindergarten_id = :kg', { kg: kindergartenId });

    if (filter.status) {
      qb.andWhere('inv.status = :status', { status: filter.status });
    }
    if (filter.dueDateFrom) {
      qb.andWhere('inv.due_date >= :dueFrom', { dueFrom: filter.dueDateFrom });
    }
    if (filter.dueDate) {
      qb.andWhere('inv.due_date <= :due', { due: filter.dueDate });
    }
    if (filter.childId) {
      qb.andWhere('inv.child_id = :child', { child: filter.childId });
    }
    if (filter.invoiceType) {
      qb.andWhere('inv.invoice_type = :it', { it: filter.invoiceType });
    }
    if (filter.periodStart) {
      qb.andWhere('inv.period_start >= :ps', { ps: filter.periodStart });
    }
    if (filter.periodEnd) {
      qb.andWhere('inv.period_end <= :pe', { pe: filter.periodEnd });
    }

    qb.orderBy('inv.created_at', 'DESC').addOrderBy('inv.id', 'DESC');
    const rows = await qb.getMany();
    return rows.map(InvoiceMapper.toDomain);
  }

  async findByChildId(
    kindergartenId: string,
    childId: string,
    filter: Omit<ListInvoicesFilter, 'childId'> = {},
  ): Promise<Invoice[]> {
    return this.list(kindergartenId, { ...filter, childId });
  }

  async existsMonthlyForPeriod(
    kindergartenId: string,
    periodStart: Date,
  ): Promise<boolean> {
    // T11 C1: filter by invoice_type='monthly' so prepayment / late_pickup_fee /
    // additional_service / one-off invoices that happen to share the same
    // period_start (typically first-of-month) do NOT block the cron.
    const count = await this.manager()
      .getRepository(InvoiceTypeOrmEntity)
      .createQueryBuilder('inv')
      .where('inv.kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere('inv.period_start = :ps', { ps: toIsoDate(periodStart) })
      .andWhere(`inv.invoice_type = 'monthly'`)
      .getCount();
    return count > 0;
  }

  async getPaidSumForInvoice(
    kindergartenId: string,
    invoiceId: string,
  ): Promise<number> {
    const m = this.manager();
    const result = await m.query(
      `SELECT COALESCE(SUM(amount), 0)::text AS sum
         FROM payments
        WHERE kindergarten_id = $1
          AND invoice_id = $2
          AND status = 'completed'`,
      [kindergartenId, invoiceId],
    );
    const sum = result?.[0]?.sum ?? '0';
    return Number(sum);
  }

  async markPaidConditional(
    kindergartenId: string,
    id: string,
    now: Date,
  ): Promise<Invoice | null> {
    return this.transitionStatusConditional(
      kindergartenId,
      id,
      ['pending', 'partial', 'overdue'],
      'paid',
      now,
    );
  }

  async markPartialConditional(
    kindergartenId: string,
    id: string,
    now: Date,
  ): Promise<Invoice | null> {
    return this.transitionStatusConditional(
      kindergartenId,
      id,
      ['pending', 'overdue'],
      'partial',
      now,
    );
  }

  async markCancelledConditional(
    kindergartenId: string,
    id: string,
    now: Date,
  ): Promise<Invoice | null> {
    return this.transitionStatusConditional(
      kindergartenId,
      id,
      ['pending', 'partial', 'overdue'],
      'cancelled',
      now,
    );
  }

  async markRefundedConditional(
    kindergartenId: string,
    id: string,
    now: Date,
  ): Promise<Invoice | null> {
    return this.transitionStatusConditional(
      kindergartenId,
      id,
      ['paid', 'partial'],
      'refunded',
      now,
    );
  }

  async markOverdueConditional(
    kindergartenId: string,
    id: string,
    now: Date,
  ): Promise<Invoice | null> {
    // B22a T1 SM1: include `partial` so an invoice that received a small
    // payment (and was flipped pending → partial) still flips to overdue
    // once past its due_date. Without `partial` such invoices stayed
    // forever in `partial` even after the due_date passed — the dunning
    // pipeline missed them entirely.
    return this.transitionStatusConditional(
      kindergartenId,
      id,
      ['pending', 'partial'],
      'overdue',
      now,
    );
  }

  /**
   * B22a T1 — Bulk overdue flip for the nightly cron. RETURNING gives
   * the cron processor enough payload to emit `invoice.overdue` events
   * for newly-flipped rows without a follow-up SELECT loop.
   *
   * Date arithmetic: `due_date < $2::date` compares the `date` column
   * against the caller-supplied Asia/Almaty calendar date string — NOT
   * a JS `Date` cast in the DB session timezone. Earlier revisions used
   * `now::date` and silently skipped invoices due "today" in Almaty when
   * the DB session was UTC (03:00 Almaty = 22:00 prev-day UTC). The
   * processor passes `formatDateInTimezone(now, 'Asia/Almaty')` so the
   * cut-off matches the local calendar day the cron is targeting (B22a
   * T13 M1 codex fix). The flipped invoice's `updated_at` becomes the
   * timestamp `$3` so the audit trail still reflects the precise
   * instant of the cron tick.
   */
  async markOverdueBatch(
    kindergartenId: string,
    today: string,
    now: Date,
  ): Promise<
    Array<{
      id: string;
      childId: string;
      amountAfterDiscount: number;
      dueDate: string;
    }>
  > {
    const m = this.manager();
    // TypeORM 0.3 `query()` for UPDATE…RETURNING returns
    // `[rows, rowCount]`; unwrap so `.map` runs against the actual
    // flipped rows. See `unwrapReturning` helper at file bottom.
    const rows = unwrapReturning<{
      id: string;
      child_id: string;
      amount_after_discount: string;
      due_date: string | Date;
    }>(
      await m.query(
        `UPDATE invoices
            SET status = 'overdue',
                updated_at = $3
          WHERE kindergarten_id = $1
            AND status IN ('pending', 'partial')
            AND due_date < $2::date
          RETURNING id, child_id, amount_after_discount, due_date`,
        [kindergartenId, today, now],
      ),
    );
    return rows.map((r) => ({
      id: r.id,
      childId: r.child_id,
      amountAfterDiscount: Number(r.amount_after_discount),
      dueDate:
        r.due_date instanceof Date
          ? r.due_date.toISOString().slice(0, 10)
          : String(r.due_date).slice(0, 10),
    }));
  }

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

  async acquireOverdueRunAdvisoryLock(
    kindergartenId: string,
    today: string,
  ): Promise<void> {
    const scope = `billing:overdue:${kindergartenId}:${today}`;
    await this.manager().query(
      `SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`,
      [scope],
    );
  }

  async findCurrentInvoiceForChildAt(
    kindergartenId: string,
    childId: string,
    atDate: Date,
  ): Promise<Invoice | null> {
    const dateIso = toIsoDate(atDate);
    const row = await this.manager()
      .getRepository(InvoiceTypeOrmEntity)
      .createQueryBuilder('inv')
      .where('inv.kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere('inv.child_id = :cid', { cid: childId })
      .andWhere('inv.period_start <= :d', { d: dateIso })
      .andWhere('inv.period_end >= :d', { d: dateIso })
      .andWhere('inv.status IN (:...statuses)', {
        statuses: ['pending', 'partial', 'overdue'],
      })
      .orderBy('inv.period_start', 'DESC')
      .limit(1)
      .getOne();
    return row ? InvoiceMapper.toDomain(row) : null;
  }

  /**
   * Conditional UPDATE: applies `nextStatus` only if current row status is
   * one of `expected`. Returns the hydrated domain on success or `null`
   * when 0 rows matched. The follow-up `findById` rehydrates after the
   * `RETURNING *` — TypeORM's raw return shape is snake_case so we re-read
   * via the entity rather than try to map raw columns.
   *
   * Mirrors the parent-request `updateStatusConditional` pattern (db8cb72)
   * but skips the `reviewed_*` patch — invoices have no equivalent admin
   * audit trail at the row level.
   */
  private async transitionStatusConditional(
    kindergartenId: string,
    id: string,
    expected: InvoiceStatus[],
    nextStatus: InvoiceStatus,
    now: Date,
  ): Promise<Invoice | null> {
    const m = this.manager();
    const result = await m
      .createQueryBuilder()
      .update(InvoiceTypeOrmEntity)
      .set({ status: nextStatus, updatedAt: now })
      .where('id = :id', { id })
      .andWhere('kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere('status IN (:...expected)', { expected })
      .returning('*')
      .execute();

    if (!result.raw?.length) {
      return null;
    }

    const row = await m
      .getRepository(InvoiceTypeOrmEntity)
      .findOne({ where: { id, kindergartenId } });
    return row ? InvoiceMapper.toDomain(row) : null;
  }

  // ── B-DASH — Dashboard aggregates ─────────────────────────────────────

  async aggregateOverdue(
    kindergartenId: string,
    today: string,
  ): Promise<{ count: number; amount: number }> {
    const result = await this.manager().query(
      `SELECT COUNT(*)::text AS count,
              COALESCE(SUM(amount_after_discount), 0)::text AS amount
         FROM invoices
        WHERE kindergarten_id = $1
          AND due_date < $2::date
          AND status IN ('pending', 'partial')`,
      [kindergartenId, today],
    );
    return {
      count: Number(result?.[0]?.count ?? 0),
      amount: Number(result?.[0]?.amount ?? 0),
    };
  }

  async aggregateByStatusBetween(
    kindergartenId: string,
    from: string,
    to: string,
    today: string,
  ): Promise<{
    paid: { count: number; amount: number };
    pending: { count: number; amount: number };
    overdue: { count: number; amount: number };
    refunded: { count: number; amount: number };
  }> {
    const result = await this.manager().query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'paid')::text AS paid_count,
         COALESCE(SUM(amount_after_discount) FILTER (WHERE status = 'paid'), 0)::text AS paid_amount,
         COUNT(*) FILTER (
           WHERE status IN ('pending', 'partial') AND due_date >= $4::date
         )::text AS pending_count,
         COALESCE(SUM(amount_after_discount) FILTER (
           WHERE status IN ('pending', 'partial') AND due_date >= $4::date
         ), 0)::text AS pending_amount,
         COUNT(*) FILTER (
           WHERE status IN ('pending', 'partial') AND due_date < $4::date
         )::text AS overdue_count,
         COALESCE(SUM(amount_after_discount) FILTER (
           WHERE status IN ('pending', 'partial') AND due_date < $4::date
         ), 0)::text AS overdue_amount,
         COUNT(*) FILTER (WHERE status = 'refunded')::text AS refunded_count,
         COALESCE(SUM(amount_after_discount) FILTER (WHERE status = 'refunded'), 0)::text AS refunded_amount
       FROM invoices
      WHERE kindergarten_id = $1
        AND period_start >= $2::date
        AND period_start <= $3::date`,
      [kindergartenId, from, to, today],
    );
    const r = result?.[0] ?? {};
    return {
      paid: {
        count: Number(r.paid_count ?? 0),
        amount: Number(r.paid_amount ?? 0),
      },
      pending: {
        count: Number(r.pending_count ?? 0),
        amount: Number(r.pending_amount ?? 0),
      },
      overdue: {
        count: Number(r.overdue_count ?? 0),
        amount: Number(r.overdue_amount ?? 0),
      },
      refunded: {
        count: Number(r.refunded_count ?? 0),
        amount: Number(r.refunded_amount ?? 0),
      },
    };
  }
}

/**
 * B22a T1 H16 helper. TypeORM 0.3.x's `EntityManager.query()` returns
 * `[Array<row>, rowCount]` for UPDATE…RETURNING (and just `Array<row>`
 * for SELECT). Treating the tuple as `Array<row>` made `length` always
 * 2 — silently nuking 0-row vs N-row checks. This helper extracts the
 * rows half. Mirrors the helper in
 * `custom-discount.relational.repository.ts`.
 */
function unwrapReturning<T>(raw: unknown): T[] {
  if (Array.isArray(raw) && raw.length === 2 && Array.isArray(raw[0])) {
    return raw[0] as T[];
  }
  if (Array.isArray(raw)) {
    return raw as T[];
  }
  return [];
}
