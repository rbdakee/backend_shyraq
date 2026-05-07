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
    return this.transitionStatusConditional(
      kindergartenId,
      id,
      ['pending'],
      'overdue',
      now,
    );
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
}
