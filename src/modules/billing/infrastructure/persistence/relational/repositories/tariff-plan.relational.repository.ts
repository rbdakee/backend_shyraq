import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { MoneyKzt } from '@/shared-kernel/domain/money-kzt';
import {
  TariffAppliesTo,
  TariffPlan,
  TariffType,
} from '../../../../domain/entities/tariff-plan.entity';
import {
  ListTariffPlansFilter,
  TariffPlanRepository,
  UpdateTariffPlanPatch,
} from '../../tariff-plan.repository';
import { TariffPlanTypeOrmEntity } from '../entities/tariff-plan.typeorm.entity';
import { TariffPlanMapper } from '../mappers/tariff-plan.mapper';
import { toIsoDate, toIsoDateOrNull } from '../mappers/date-utils';

@Injectable()
export class TariffPlanRelationalRepository extends TariffPlanRepository {
  constructor(
    @InjectRepository(TariffPlanTypeOrmEntity)
    private readonly repo: Repository<TariffPlanTypeOrmEntity>,
  ) {
    super();
  }

  private manager(override?: EntityManager): EntityManager {
    return (
      override ?? tenantStorage.getStore()?.entityManager ?? this.repo.manager
    );
  }

  async create(plan: TariffPlan): Promise<TariffPlan> {
    const m = this.manager().getRepository(TariffPlanTypeOrmEntity);
    const s = plan.toState();
    await m.insert({
      id: s.id,
      kindergartenId: s.kindergartenId,
      name: s.name,
      description: s.description,
      tariffType: s.tariffType,
      amount: s.amount,
      currency: s.currency,
      appliesTo: s.appliesTo,
      groupId: s.groupId,
      ageMinMonths: s.ageMinMonths,
      ageMaxMonths: s.ageMaxMonths,
      isActive: s.isActive,
      validFrom: toIsoDate(s.validFrom),
      validUntil: toIsoDateOrNull(s.validUntil),
      discountRules: s.discountRules,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    });
    return plan;
  }

  async update(
    kindergartenId: string,
    id: string,
    patch: UpdateTariffPlanPatch,
    now: Date,
  ): Promise<TariffPlan | null> {
    const m = this.manager().getRepository(TariffPlanTypeOrmEntity);
    const setPayload: Partial<TariffPlanTypeOrmEntity> = { updatedAt: now };
    if (patch.name !== undefined) setPayload.name = patch.name;
    if (patch.description !== undefined)
      setPayload.description = patch.description;
    if (patch.amount !== undefined) {
      setPayload.amount = MoneyKzt.fromKzt(patch.amount);
    }
    if (patch.appliesTo !== undefined) setPayload.appliesTo = patch.appliesTo;
    if (patch.groupId !== undefined) setPayload.groupId = patch.groupId;
    if (patch.ageMinMonths !== undefined) {
      setPayload.ageMinMonths = patch.ageMinMonths;
    }
    if (patch.ageMaxMonths !== undefined) {
      setPayload.ageMaxMonths = patch.ageMaxMonths;
    }
    if (patch.isActive !== undefined) setPayload.isActive = patch.isActive;
    if (patch.validFrom !== undefined) {
      setPayload.validFrom = toIsoDate(patch.validFrom);
    }
    if (patch.validUntil !== undefined) {
      setPayload.validUntil = toIsoDateOrNull(patch.validUntil);
    }
    if (patch.discountRules !== undefined) {
      setPayload.discountRules = patch.discountRules;
    }

    const result = await m.update({ id, kindergartenId }, setPayload);
    if (!result.affected) return null;
    const row = await m.findOne({ where: { id, kindergartenId } });
    return row ? TariffPlanMapper.toDomain(row) : null;
  }

  async save(plan: TariffPlan): Promise<TariffPlan> {
    const m = this.manager().getRepository(TariffPlanTypeOrmEntity);
    const s = plan.toState();
    await m.update(
      { id: s.id, kindergartenId: s.kindergartenId },
      {
        name: s.name,
        description: s.description,
        amount: s.amount,
        appliesTo: s.appliesTo,
        groupId: s.groupId,
        ageMinMonths: s.ageMinMonths,
        ageMaxMonths: s.ageMaxMonths,
        isActive: s.isActive,
        validFrom: toIsoDate(s.validFrom),
        validUntil: toIsoDateOrNull(s.validUntil),
        discountRules: s.discountRules,
        updatedAt: s.updatedAt,
      },
    );
    return plan;
  }

  async findById(
    kindergartenId: string,
    id: string,
  ): Promise<TariffPlan | null> {
    const row = await this.manager()
      .getRepository(TariffPlanTypeOrmEntity)
      .findOne({ where: { id, kindergartenId } });
    return row ? TariffPlanMapper.toDomain(row) : null;
  }

  async findActiveByType(
    kindergartenId: string,
    tariffType: TariffType,
    atDate?: Date,
  ): Promise<TariffPlan | null> {
    const dateIso = toIsoDate(atDate ?? new Date());
    const row = await this.manager()
      .getRepository(TariffPlanTypeOrmEntity)
      .createQueryBuilder('tp')
      .where('tp.kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere('tp.tariff_type = :tt', { tt: tariffType })
      .andWhere('tp.is_active = true')
      .andWhere('tp.valid_from <= :d', { d: dateIso })
      .andWhere('(tp.valid_until IS NULL OR tp.valid_until >= :d)', {
        d: dateIso,
      })
      .orderBy('tp.valid_from', 'DESC')
      .limit(1)
      .getOne();
    return row ? TariffPlanMapper.toDomain(row) : null;
  }

  async list(
    kindergartenId: string,
    filter: ListTariffPlansFilter = {},
  ): Promise<TariffPlan[]> {
    const qb = this.manager()
      .getRepository(TariffPlanTypeOrmEntity)
      .createQueryBuilder('tp')
      .where('tp.kindergarten_id = :kg', { kg: kindergartenId });

    if (filter.isActive !== undefined) {
      qb.andWhere('tp.is_active = :a', { a: filter.isActive });
    }
    if (filter.tariffType !== undefined) {
      qb.andWhere('tp.tariff_type = :tt', { tt: filter.tariffType });
    }
    if (filter.groupId !== undefined) {
      if (filter.groupId === null) {
        qb.andWhere('tp.group_id IS NULL');
      } else {
        qb.andWhere('tp.group_id = :gid', { gid: filter.groupId });
      }
    }

    qb.orderBy('tp.created_at', 'DESC').addOrderBy('tp.id', 'DESC');
    const rows = await qb.getMany();
    return rows.map(TariffPlanMapper.toDomain);
  }

  async existsOverlap(
    kindergartenId: string,
    tariffType: TariffType,
    appliesTo: TariffAppliesTo,
    groupId: string | null,
    validFrom: Date,
    validUntil: Date | null,
    excludeId?: string,
  ): Promise<boolean> {
    // `individual` plans never collide at catalogue level — per-child rules
    // are managed via `tariff_assignments`.
    if (appliesTo === 'individual') return false;

    const fromIso = toIsoDate(validFrom);
    const untilIso = toIsoDateOrNull(validUntil);

    const qb = this.manager()
      .getRepository(TariffPlanTypeOrmEntity)
      .createQueryBuilder('tp')
      .where('tp.kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere('tp.tariff_type = :tt', { tt: tariffType })
      .andWhere('tp.is_active = true');

    // Granularity:
    //   all_children → no extra filter (collision is per kg + tariff_type)
    //   group        → match on group_id
    //   age_range    → any other age_range row of same type is a candidate
    //                  for window-overlap (we don't compare age bounds —
    //                  admins should close+reopen to widen).
    if (appliesTo === 'group') {
      qb.andWhere('tp.applies_to = :at', { at: appliesTo });
      if (groupId === null) {
        qb.andWhere('tp.group_id IS NULL');
      } else {
        qb.andWhere('tp.group_id = :gid', { gid: groupId });
      }
    } else if (appliesTo === 'age_range') {
      qb.andWhere('tp.applies_to = :at', { at: appliesTo });
    } else {
      // all_children — collision is per kg + tariff_type
      qb.andWhere('tp.applies_to = :at', { at: appliesTo });
    }

    // Window overlap test: two windows [a1,a2] and [b1,b2] (NULL = +∞)
    // overlap iff a1 <= b2 AND b1 <= a2.
    if (untilIso === null) {
      qb.andWhere('(tp.valid_until IS NULL OR tp.valid_until >= :from)', {
        from: fromIso,
      });
    } else {
      qb.andWhere('tp.valid_from <= :until', { until: untilIso }).andWhere(
        '(tp.valid_until IS NULL OR tp.valid_until >= :from)',
        { from: fromIso },
      );
    }

    if (excludeId) {
      qb.andWhere('tp.id <> :exId', { exId: excludeId });
    }

    const count = await qb.getCount();
    return count > 0;
  }

  async acquireOverlapAdvisoryLock(
    kindergartenId: string,
    tariffType: TariffType,
    appliesTo: TariffAppliesTo,
    groupId: string | null,
    manager?: EntityManager,
  ): Promise<void> {
    const m = this.manager(manager);
    // Key includes `applies_to` so a `group` plan with a null `group_id`
    // and an `all_children` plan don't share a lock. The literal `null`
    // segment for `group_id` follows the existing M11 convention used by
    // billing repos (cf. payment / refund).
    const scope = `tariff-overlap:${kindergartenId}:${tariffType}:${appliesTo}:${groupId ?? 'null'}`;
    await m.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [
      scope,
    ]);
  }
}
