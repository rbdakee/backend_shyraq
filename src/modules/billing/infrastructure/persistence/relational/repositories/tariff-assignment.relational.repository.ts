import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { MoneyKzt } from '@/shared-kernel/domain/money-kzt';
import { TariffAssignment } from '../../../../domain/entities/tariff-assignment.entity';
import {
  CreateTariffAssignmentInput,
  ListTariffAssignmentsFilter,
  TariffAssignmentRepository,
  UpdateTariffAssignmentPatch,
} from '../../tariff-assignment.repository';
import { TariffAssignmentTypeOrmEntity } from '../entities/tariff-assignment.typeorm.entity';
import { TariffAssignmentMapper } from '../mappers/tariff-assignment.mapper';
import { toIsoDate, toIsoDateOrNull } from '../mappers/date-utils';

@Injectable()
export class TariffAssignmentRelationalRepository extends TariffAssignmentRepository {
  constructor(
    @InjectRepository(TariffAssignmentTypeOrmEntity)
    private readonly repo: Repository<TariffAssignmentTypeOrmEntity>,
  ) {
    super();
  }

  private manager(): EntityManager {
    return tenantStorage.getStore()?.entityManager ?? this.repo.manager;
  }

  async create(input: CreateTariffAssignmentInput): Promise<TariffAssignment> {
    const m = this.manager().getRepository(TariffAssignmentTypeOrmEntity);
    const inserted = m.create({
      kindergartenId: input.kindergartenId,
      childId: input.childId,
      tariffPlanId: input.tariffPlanId,
      customAmount:
        input.customAmount === null
          ? null
          : MoneyKzt.fromKzt(input.customAmount),
      customReason: input.customReason,
      validFrom: toIsoDate(input.validFrom),
      validUntil: toIsoDateOrNull(input.validUntil),
      assignedBy: input.assignedBy,
    });
    const saved = await m.save(inserted);
    return TariffAssignmentMapper.toDomain(saved);
  }

  async update(
    kindergartenId: string,
    id: string,
    patch: UpdateTariffAssignmentPatch,
    now: Date,
  ): Promise<TariffAssignment | null> {
    const m = this.manager().getRepository(TariffAssignmentTypeOrmEntity);
    const setPayload: Partial<TariffAssignmentTypeOrmEntity> = {
      updatedAt: now,
    };
    if (patch.tariffPlanId !== undefined) {
      setPayload.tariffPlanId = patch.tariffPlanId;
    }
    if (patch.customAmount !== undefined) {
      setPayload.customAmount =
        patch.customAmount === null
          ? null
          : MoneyKzt.fromKzt(patch.customAmount);
    }
    if (patch.customReason !== undefined) {
      setPayload.customReason = patch.customReason;
    }
    if (patch.validFrom !== undefined) {
      setPayload.validFrom = toIsoDate(patch.validFrom);
    }
    if (patch.validUntil !== undefined) {
      setPayload.validUntil = toIsoDateOrNull(patch.validUntil);
    }

    const result = await m.update({ id, kindergartenId }, setPayload);
    if (!result.affected) return null;
    const row = await m.findOne({ where: { id, kindergartenId } });
    return row ? TariffAssignmentMapper.toDomain(row) : null;
  }

  async save(assignment: TariffAssignment): Promise<TariffAssignment> {
    const m = this.manager().getRepository(TariffAssignmentTypeOrmEntity);
    const s = assignment.toState();
    await m.update(
      { id: s.id, kindergartenId: s.kindergartenId },
      {
        tariffPlanId: s.tariffPlanId,
        customAmount: s.customAmount,
        customReason: s.customReason,
        validFrom: toIsoDate(s.validFrom),
        validUntil: toIsoDateOrNull(s.validUntil),
        updatedAt: s.updatedAt,
      },
    );
    return assignment;
  }

  async findById(
    kindergartenId: string,
    id: string,
  ): Promise<TariffAssignment | null> {
    const row = await this.manager()
      .getRepository(TariffAssignmentTypeOrmEntity)
      .findOne({ where: { id, kindergartenId } });
    return row ? TariffAssignmentMapper.toDomain(row) : null;
  }

  async findActiveForChild(
    kindergartenId: string,
    childId: string,
    atDate: Date,
  ): Promise<TariffAssignment | null> {
    const dateIso = toIsoDate(atDate);
    const row = await this.manager()
      .getRepository(TariffAssignmentTypeOrmEntity)
      .createQueryBuilder('ta')
      .where('ta.kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere('ta.child_id = :cid', { cid: childId })
      .andWhere('ta.valid_from <= :d', { d: dateIso })
      .andWhere('(ta.valid_until IS NULL OR ta.valid_until >= :d)', {
        d: dateIso,
      })
      .orderBy('ta.valid_from', 'DESC')
      .limit(1)
      .getOne();
    return row ? TariffAssignmentMapper.toDomain(row) : null;
  }

  async findAllActiveAtDate(
    kindergartenId: string,
    atDate: Date,
  ): Promise<TariffAssignment[]> {
    const dateIso = toIsoDate(atDate);
    const rows = await this.manager()
      .getRepository(TariffAssignmentTypeOrmEntity)
      .createQueryBuilder('ta')
      .where('ta.kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere('ta.valid_from <= :d', { d: dateIso })
      .andWhere('(ta.valid_until IS NULL OR ta.valid_until >= :d)', {
        d: dateIso,
      })
      .orderBy('ta.child_id', 'ASC')
      .addOrderBy('ta.valid_from', 'DESC')
      .getMany();
    return rows.map(TariffAssignmentMapper.toDomain);
  }

  async existsOverlap(
    kindergartenId: string,
    childId: string,
    validFrom: Date,
    validUntil: Date | null,
    excludeId?: string,
  ): Promise<boolean> {
    const fromIso = toIsoDate(validFrom);
    const untilIso = toIsoDateOrNull(validUntil);

    const qb = this.manager()
      .getRepository(TariffAssignmentTypeOrmEntity)
      .createQueryBuilder('ta')
      .where('ta.kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere('ta.child_id = :cid', { cid: childId });

    // Two windows [a1,a2] and [b1,b2] (with NULL = +∞) overlap iff
    //   a1 <= b2 AND b1 <= a2
    // We treat existing.valid_until=NULL as +∞ via IS NULL branch.
    if (untilIso === null) {
      // proposed window is open-ended (until=+∞), so it overlaps if
      // existing.valid_from <= +∞ (always true) AND fromIso <= existing.valid_until-or-+∞
      qb.andWhere('(ta.valid_until IS NULL OR ta.valid_until >= :from)', {
        from: fromIso,
      });
    } else {
      qb.andWhere('ta.valid_from <= :until', { until: untilIso }).andWhere(
        '(ta.valid_until IS NULL OR ta.valid_until >= :from)',
        { from: fromIso },
      );
    }

    if (excludeId) {
      qb.andWhere('ta.id <> :exId', { exId: excludeId });
    }

    const count = await qb.getCount();
    return count > 0;
  }

  async list(
    kindergartenId: string,
    filter: ListTariffAssignmentsFilter = {},
  ): Promise<TariffAssignment[]> {
    const qb = this.manager()
      .getRepository(TariffAssignmentTypeOrmEntity)
      .createQueryBuilder('ta')
      .where('ta.kindergarten_id = :kg', { kg: kindergartenId });

    if (filter.childId) {
      qb.andWhere('ta.child_id = :cid', { cid: filter.childId });
    }

    qb.orderBy('ta.created_at', 'DESC').addOrderBy('ta.id', 'DESC');
    const rows = await qb.getMany();
    return rows.map(TariffAssignmentMapper.toDomain);
  }

  async acquireAssignChildAdvisoryLock(
    kindergartenId: string,
    childId: string,
  ): Promise<void> {
    const scope = `billing:tariff-assign:${kindergartenId}:${childId}`;
    await this.manager().query(
      `SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`,
      [scope],
    );
  }

  async closeActiveForChild(
    kindergartenId: string,
    childId: string,
    validUntil: Date,
  ): Promise<{ closedCount: number }> {
    // Single bulk UPDATE — clamps both NULL (open-ended) and
    // strictly-greater valid_until windows down to `$validUntil`. Rows
    // whose valid_until is already <= $validUntil are skipped (the
    // assignment is already closed in the past relative to the archive
    // date — nothing to do).
    //
    // `valid_until` is a `date` column (no time-of-day) — feed it the
    // YYYY-MM-DD form. `updated_at` is a `timestamptz`, so it gets the
    // actual archive instant (`validUntil` as a Date) — T7-M3 fix.
    // Previously both columns received the date-only string, which
    // silently stored `updated_at` at midnight UTC of the archive day.
    const result = (await this.manager().query(
      `UPDATE tariff_assignments
          SET valid_until = $3, updated_at = $4
        WHERE kindergarten_id = $1
          AND child_id = $2
          AND (valid_until IS NULL OR valid_until > $3)`,
      [kindergartenId, childId, toIsoDate(validUntil), validUntil],
    )) as unknown;
    // pg driver returns `[rows, count]` for UPDATE/INSERT/DELETE; the
    // raw `query()` shape is `[rows: any[], affected: number]`.
    let closedCount = 0;
    if (Array.isArray(result) && result.length >= 2) {
      const second = result[1];
      if (typeof second === 'number') closedCount = second;
    }
    return { closedCount };
  }

  async listActiveChildIdsByTariffPlanIds(
    kindergartenId: string,
    tariffPlanIds: string[],
    now: Date,
  ): Promise<string[]> {
    if (tariffPlanIds.length === 0) return [];
    const dateIso = toIsoDate(now);
    const rows = (await this.manager().query(
      `SELECT DISTINCT child_id
         FROM tariff_assignments
        WHERE kindergarten_id = $1
          AND tariff_plan_id = ANY($2::uuid[])
          AND valid_from <= $3
          AND (valid_until IS NULL OR valid_until >= $3)`,
      [kindergartenId, tariffPlanIds, dateIso],
    )) as Array<{ child_id: string }>;
    return rows.map((r) => r.child_id);
  }
}
