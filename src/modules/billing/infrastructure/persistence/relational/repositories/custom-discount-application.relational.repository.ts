import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { tenantStorage } from '@/database/tenant-storage';
import { MoneyKzt } from '@/shared-kernel/domain/money-kzt';
import {
  CreateCustomDiscountApplicationInput,
  CustomDiscountApplicationRepository,
  CustomDiscountApplicationStats,
} from '../../../../custom-discount-application.repository';
import { CustomDiscountApplication } from '../../../../domain/entities/custom-discount-application.entity';
import { CustomDiscountPageRequest } from '../../../../custom-discount.repository';
import { CustomDiscountApplicationTypeOrmEntity } from '../entities/custom-discount-application.typeorm.entity';
import { CustomDiscountApplicationMapper } from '../mappers/custom-discount-application.mapper';

@Injectable()
export class CustomDiscountApplicationRelationalRepository extends CustomDiscountApplicationRepository {
  constructor(
    @InjectRepository(CustomDiscountApplicationTypeOrmEntity)
    private readonly repo: Repository<CustomDiscountApplicationTypeOrmEntity>,
  ) {
    super();
  }

  private manager(explicit?: EntityManager): EntityManager {
    if (explicit) return explicit;
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.repo.manager;
  }

  async create(
    input: CreateCustomDiscountApplicationInput,
    manager?: EntityManager,
  ): Promise<CustomDiscountApplication> {
    const m = this.manager(manager).getRepository(
      CustomDiscountApplicationTypeOrmEntity,
    );
    const id = randomUUID();
    const appliedAt = new Date();
    await m.insert({
      id,
      kindergartenId: input.kindergartenId,
      customDiscountId: input.customDiscountId,
      invoiceId: input.invoiceId,
      invoiceLineItemId: input.invoiceLineItemId,
      childId: input.childId,
      amountApplied: MoneyKzt.fromKzt(input.amountApplied),
      appliedAt,
    });
    const row = await m.findOne({
      where: { id, kindergartenId: input.kindergartenId },
    });
    if (!row) {
      throw new Error('custom_discount_application_create_failed_to_rehydrate');
    }
    return CustomDiscountApplicationMapper.toDomain(row);
  }

  async countByChildAndDiscount(
    kindergartenId: string,
    childId: string,
    customDiscountId: string,
    manager?: EntityManager,
  ): Promise<number> {
    const m = this.manager(manager);
    // Cancelled/refunded invoices must not consume capped discount slots
    // (handoff §5.3): the ledger is insert-only, so a per-child cap check
    // that counts every row would keep a slot burnt after its invoice was
    // voided (prepayment retry P2 / settlement auto-cancel P5). Excluding
    // voided invoices here frees the slot without a ledger delete. LEFT
    // JOIN + `inv.id IS NULL` keeps orphan rows counted (fail-closed).
    return m
      .getRepository(CustomDiscountApplicationTypeOrmEntity)
      .createQueryBuilder('app')
      .leftJoin(
        'invoices',
        'inv',
        'inv.id = app.invoice_id AND inv.kindergarten_id = app.kindergarten_id',
      )
      .where('app.kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere('app.child_id = :cid', { cid: childId })
      .andWhere('app.custom_discount_id = :did', { did: customDiscountId })
      .andWhere(
        `(inv.id IS NULL OR inv.status NOT IN ('cancelled', 'refunded'))`,
      )
      .getCount();
  }

  async listByInvoiceId(
    kindergartenId: string,
    invoiceId: string,
  ): Promise<CustomDiscountApplication[]> {
    const rows = await this.manager()
      .getRepository(CustomDiscountApplicationTypeOrmEntity)
      .createQueryBuilder('app')
      .where('app.kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere('app.invoice_id = :inv', { inv: invoiceId })
      .orderBy('app.applied_at', 'ASC')
      .addOrderBy('app.id', 'ASC')
      .getMany();
    return rows.map(CustomDiscountApplicationMapper.toDomain);
  }

  async listByDiscountId(
    kindergartenId: string,
    customDiscountId: string,
    pagination: CustomDiscountPageRequest,
  ): Promise<{ rows: CustomDiscountApplication[]; total: number }> {
    const m = this.manager();
    const qb = m
      .getRepository(CustomDiscountApplicationTypeOrmEntity)
      .createQueryBuilder('app')
      .where('app.kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere('app.custom_discount_id = :did', { did: customDiscountId })
      .orderBy('app.applied_at', 'DESC')
      .addOrderBy('app.id', 'DESC')
      .skip(pagination.offset)
      .take(pagination.limit);
    const [rows, total] = await qb.getManyAndCount();
    return {
      rows: rows.map(CustomDiscountApplicationMapper.toDomain),
      total,
    };
  }

  async getStatsForDiscount(
    kindergartenId: string,
    customDiscountId: string,
  ): Promise<CustomDiscountApplicationStats> {
    const m = this.manager();
    const result = (await m.query(
      `SELECT COUNT(*)::int       AS count,
              COALESCE(SUM(amount_applied), 0)::text AS total
         FROM custom_discount_applications
        WHERE kindergarten_id = $1
          AND custom_discount_id = $2`,
      [kindergartenId, customDiscountId],
    )) as Array<{ count: number; total: string }>;
    const row = result[0];
    return {
      count: row?.count ?? 0,
      totalAmountApplied: row?.total !== undefined ? Number(row.total) : 0,
    };
  }
}
