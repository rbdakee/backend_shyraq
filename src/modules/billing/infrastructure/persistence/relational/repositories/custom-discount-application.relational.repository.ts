import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { tenantStorage } from '@/database/tenant-storage';
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
      amountApplied: input.amountApplied,
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
    return m
      .getRepository(CustomDiscountApplicationTypeOrmEntity)
      .createQueryBuilder('app')
      .where('app.kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere('app.child_id = :cid', { cid: childId })
      .andWhere('app.custom_discount_id = :did', { did: customDiscountId })
      .getCount();
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
