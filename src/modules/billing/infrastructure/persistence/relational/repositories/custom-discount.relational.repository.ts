import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { randomUUID } from 'node:crypto';
import {
  CreateCustomDiscountInput,
  CustomDiscountPageRequest,
  CustomDiscountRepository,
  ListCustomDiscountsFilter,
  UpdateCustomDiscountPatch,
} from '../../../../custom-discount.repository';
import {
  CustomDiscount,
  CustomDiscountStatus,
} from '../../../../domain/entities/custom-discount.entity';
import { CustomDiscountTypeOrmEntity } from '../entities/custom-discount.typeorm.entity';
import { CustomDiscountMapper } from '../mappers/custom-discount.mapper';

@Injectable()
export class CustomDiscountRelationalRepository extends CustomDiscountRepository {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(CustomDiscountTypeOrmEntity)
    private readonly repo: Repository<CustomDiscountTypeOrmEntity>,
  ) {
    super();
  }

  /**
   * Working manager resolution. Caller-supplied `manager` (used by service
   * activation flow + DiscountExpireProcessor) wins, then `tenantStorage`
   * (HTTP), then default pool manager.
   */
  private manager(explicit?: EntityManager): EntityManager {
    if (explicit) return explicit;
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.dataSource.manager;
  }

  async create(input: CreateCustomDiscountInput): Promise<CustomDiscount> {
    const m = this.manager();
    const repo = m.getRepository(CustomDiscountTypeOrmEntity);
    const id = randomUUID();
    // Raw INSERT via the working manager — TypeORM's typed `repo.insert`
    // is awkward to satisfy here because `Record<string, unknown>` on
    // jsonb columns trips its `_QueryDeepPartialEntity` constraint. Raw
    // query keeps the binding explicit and round-trips JSONB cleanly.
    await m.query(
      `INSERT INTO custom_discounts
         (id, kindergarten_id, name, description, discount_type, amount,
          conditions, target_type, target_ids, valid_from, valid_until,
          max_uses_per_child, total_max_uses, used_count, priority,
          stackable, notify_on_activation, notification_title,
          notification_body, status, created_by)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::custom_discount_type, $6,
               $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
               $18::jsonb, $19::jsonb, 'draft', $20)`,
      [
        id,
        input.kindergartenId,
        JSON.stringify(input.name),
        input.description === null ? null : JSON.stringify(input.description),
        input.discountType,
        input.amount,
        JSON.stringify(input.conditions ?? {}),
        input.targetType,
        input.targetIds,
        input.validFrom,
        input.validUntil,
        input.maxUsesPerChild,
        input.totalMaxUses,
        0,
        input.priority,
        input.stackable,
        input.notifyOnActivation,
        input.notificationTitle === null
          ? null
          : JSON.stringify(input.notificationTitle),
        input.notificationBody === null
          ? null
          : JSON.stringify(input.notificationBody),
        input.createdBy,
      ],
    );
    const row = await repo.findOne({
      where: { id, kindergartenId: input.kindergartenId },
    });
    if (!row) {
      // Should be unreachable — INSERT just succeeded.
      throw new Error('custom_discount_create_failed_to_rehydrate');
    }
    return CustomDiscountMapper.toDomain(row);
  }

  async findById(
    kindergartenId: string,
    id: string,
  ): Promise<CustomDiscount | null> {
    const row = await this.manager()
      .getRepository(CustomDiscountTypeOrmEntity)
      .findOne({ where: { id, kindergartenId } });
    return row ? CustomDiscountMapper.toDomain(row) : null;
  }

  async findByIdForUpdate(
    kindergartenId: string,
    id: string,
    manager?: EntityManager,
  ): Promise<CustomDiscount | null> {
    const m = this.manager(manager);
    const row = await m
      .getRepository(CustomDiscountTypeOrmEntity)
      .createQueryBuilder('cd')
      .where('cd.id = :id', { id })
      .andWhere('cd.kindergarten_id = :kg', { kg: kindergartenId })
      .setLock('pessimistic_write')
      .getOne();
    return row ? CustomDiscountMapper.toDomain(row) : null;
  }

  async update(
    kindergartenId: string,
    id: string,
    patch: UpdateCustomDiscountPatch,
    expectedStatus?: CustomDiscountStatus,
    manager?: EntityManager,
  ): Promise<CustomDiscount | null> {
    const m = this.manager(manager);
    const setPayload: Partial<CustomDiscountTypeOrmEntity> = {
      updatedAt: new Date(),
    };
    if (patch.name !== undefined) setPayload.name = patch.name;
    if (patch.description !== undefined)
      setPayload.description = patch.description;
    if (patch.discountType !== undefined)
      setPayload.discountType = patch.discountType;
    if (patch.amount !== undefined) setPayload.amount = patch.amount;
    if (patch.conditions !== undefined)
      setPayload.conditions = patch.conditions as unknown as Record<
        string,
        unknown
      >;
    if (patch.targetType !== undefined)
      setPayload.targetType = patch.targetType;
    if (patch.targetIds !== undefined) setPayload.targetIds = patch.targetIds;
    if (patch.validFrom !== undefined) setPayload.validFrom = patch.validFrom;
    if (patch.validUntil !== undefined)
      setPayload.validUntil = patch.validUntil;
    if (patch.maxUsesPerChild !== undefined)
      setPayload.maxUsesPerChild = patch.maxUsesPerChild;
    if (patch.totalMaxUses !== undefined)
      setPayload.totalMaxUses = patch.totalMaxUses;
    if (patch.priority !== undefined) setPayload.priority = patch.priority;
    if (patch.stackable !== undefined) setPayload.stackable = patch.stackable;
    if (patch.notifyOnActivation !== undefined)
      setPayload.notifyOnActivation = patch.notifyOnActivation;
    if (patch.notificationTitle !== undefined)
      setPayload.notificationTitle = patch.notificationTitle;
    if (patch.notificationBody !== undefined)
      setPayload.notificationBody = patch.notificationBody;

    const qb = m
      .createQueryBuilder()
      .update(CustomDiscountTypeOrmEntity)
      .set(setPayload)
      .where('id = :id', { id })
      .andWhere('kindergarten_id = :kg', { kg: kindergartenId });
    if (expectedStatus !== undefined) {
      qb.andWhere('status = :expected', { expected: expectedStatus });
    }
    const result = await qb.returning('*').execute();
    if (!result.raw?.length) {
      return null;
    }
    const row = await m
      .getRepository(CustomDiscountTypeOrmEntity)
      .findOne({ where: { id, kindergartenId } });
    return row ? CustomDiscountMapper.toDomain(row) : null;
  }

  async transitionStatus(
    kindergartenId: string,
    id: string,
    fromStatus: CustomDiscountStatus | CustomDiscountStatus[],
    toStatus: CustomDiscountStatus,
    now: Date,
    manager?: EntityManager,
  ): Promise<CustomDiscount | null> {
    const m = this.manager(manager);
    const expected = Array.isArray(fromStatus) ? fromStatus : [fromStatus];
    const result = await m
      .createQueryBuilder()
      .update(CustomDiscountTypeOrmEntity)
      .set({ status: toStatus, updatedAt: now })
      .where('id = :id', { id })
      .andWhere('kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere('status IN (:...expected)', { expected })
      .returning('*')
      .execute();
    if (!result.raw?.length) {
      return null;
    }
    const row = await m
      .getRepository(CustomDiscountTypeOrmEntity)
      .findOne({ where: { id, kindergartenId } });
    return row ? CustomDiscountMapper.toDomain(row) : null;
  }

  async list(
    kindergartenId: string,
    filter: ListCustomDiscountsFilter,
    pagination: CustomDiscountPageRequest,
  ): Promise<{ rows: CustomDiscount[]; total: number }> {
    const m = this.manager();
    const qb = m
      .getRepository(CustomDiscountTypeOrmEntity)
      .createQueryBuilder('cd')
      .where('cd.kindergarten_id = :kg', { kg: kindergartenId });

    if (filter.status !== undefined) {
      qb.andWhere('cd.status = :status', { status: filter.status });
    }
    if (filter.validFromTo !== undefined) {
      qb.andWhere('cd.valid_from <= :vft', { vft: filter.validFromTo });
    }
    if (filter.validUntilFrom !== undefined) {
      qb.andWhere('(cd.valid_until IS NULL OR cd.valid_until >= :vuf)', {
        vuf: filter.validUntilFrom,
      });
    }
    if (filter.targetType !== undefined) {
      qb.andWhere('cd.target_type = :tt', { tt: filter.targetType });
    }

    qb.orderBy('cd.created_at', 'DESC')
      .addOrderBy('cd.id', 'DESC')
      .skip(pagination.offset)
      .take(pagination.limit);

    const [rows, total] = await qb.getManyAndCount();
    return {
      rows: rows.map(CustomDiscountMapper.toDomain),
      total,
    };
  }

  async incrementUsedCount(
    kindergartenId: string,
    id: string,
    by: number,
    manager?: EntityManager,
  ): Promise<boolean> {
    const m = this.manager(manager);
    // Single-statement guarded UPDATE — RETURNING the id makes the
    // 0-row case detectable. If `total_max_uses IS NULL` the cap is
    // disabled and the update always succeeds (modulo tenant scope).
    //
    // B22a T1 H16 follow-on: TypeORM's `m.query()` returns
    // `[rows, rowCount]` for UPDATE…RETURNING. Treating the tuple as
    // `Array<row>` (length=2 always) silently nuked the cap check
    // before this fix. `unwrapReturning` extracts the rows half.
    const result = unwrapReturning<{ id: string }>(
      await m.query(
        `UPDATE custom_discounts
            SET used_count = used_count + $3,
                updated_at = now()
          WHERE id = $1
            AND kindergarten_id = $2
            AND (total_max_uses IS NULL OR used_count + $3 <= total_max_uses)
          RETURNING id`,
        [id, kindergartenId, by],
      ),
    );
    return result.length > 0;
  }

  async tryReserveUsage(
    kindergartenId: string,
    id: string,
    manager?: EntityManager,
  ): Promise<boolean> {
    const m = this.manager(manager);
    // B22a T1 H16: single-statement atomic reserve. PostgreSQL evaluates
    // the WHERE inside the UPDATE under row-locking semantics — concurrent
    // reservers serialise on the row. The first writer to flip
    // `used_count` past the cap blocks all later reservers (their WHERE
    // becomes false at re-check). RETURNING `used_count` lets the caller
    // log the post-reserve count if useful.
    //
    // TypeORM `query()` for UPDATE…RETURNING returns `[rows, rowCount]`;
    // we unwrap the rows half so `length` reflects the actual flipped
    // row count (0 or 1).
    const result = unwrapReturning<{ used_count: number }>(
      await m.query(
        `UPDATE custom_discounts
            SET used_count = used_count + 1,
                updated_at = now()
          WHERE id = $1
            AND kindergarten_id = $2
            AND (total_max_uses IS NULL OR used_count < total_max_uses)
          RETURNING used_count`,
        [id, kindergartenId],
      ),
    );
    return result.length > 0;
  }

  async releaseUsage(
    kindergartenId: string,
    id: string,
    manager?: EntityManager,
  ): Promise<void> {
    const m = this.manager(manager);
    // `GREATEST(used_count - 1, 0)` guards against underflow if a caller
    // double-releases. The preferred path is TX-rollback (no release
    // needed); this method exists for cron flows that don't roll back
    // the whole batch on a per-child failure.
    await m.query(
      `UPDATE custom_discounts
          SET used_count = GREATEST(used_count - 1, 0),
              updated_at = now()
        WHERE id = $1
          AND kindergarten_id = $2`,
      [id, kindergartenId],
    );
  }

  async findActiveCustomDiscounts(
    kindergartenId: string,
    now: Date,
    manager?: EntityManager,
  ): Promise<CustomDiscount[]> {
    const m = this.manager(manager);
    const rows = await m
      .getRepository(CustomDiscountTypeOrmEntity)
      .createQueryBuilder('cd')
      .where('cd.kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere(`cd.status = 'active'`)
      .andWhere('cd.valid_from <= :now', { now })
      .andWhere('(cd.valid_until IS NULL OR cd.valid_until > :now)', { now })
      .orderBy('cd.priority', 'DESC')
      .addOrderBy('cd.created_at', 'ASC')
      .getMany();
    return rows.map(CustomDiscountMapper.toDomain);
  }

  async findOverdueActive(
    kindergartenId: string,
    now: Date,
    manager?: EntityManager,
  ): Promise<CustomDiscount[]> {
    const m = this.manager(manager);
    const rows = await m
      .getRepository(CustomDiscountTypeOrmEntity)
      .createQueryBuilder('cd')
      .where('cd.kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere(`cd.status = 'active'`)
      .andWhere('cd.valid_until IS NOT NULL')
      .andWhere('cd.valid_until <= :now', { now })
      .getMany();
    return rows.map(CustomDiscountMapper.toDomain);
  }

  async markExpiredBatch(
    kindergartenId: string,
    now: Date,
    manager?: EntityManager,
  ): Promise<{ rowIds: string[]; rowCount: number }> {
    const m = this.manager(manager);
    // B22a T1 H16 ripple: TypeORM `query()` returns `[rows, rowCount]`
    // for UPDATE…RETURNING. Unwrap so `rowCount` reflects the actual
    // flipped count.
    const result = unwrapReturning<{ id: string }>(
      await m.query(
        `UPDATE custom_discounts
            SET status = 'expired',
                updated_at = $2
          WHERE kindergarten_id = $1
            AND status IN ('active', 'paused')
            AND valid_until IS NOT NULL
            AND valid_until <= $2
          RETURNING id`,
        [kindergartenId, now],
      ),
    );
    return {
      rowIds: result.map((r) => r.id),
      rowCount: result.length,
    };
  }

  async acquireDiscountActivationAdvisoryLock(
    kindergartenId: string,
    id: string,
    manager?: EntityManager,
  ): Promise<void> {
    const m = this.manager(manager);
    const scope = `discount:activation:${kindergartenId}:${id}`;
    await m.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [
      scope,
    ]);
  }

  async acquireDiscountApplyAdvisoryLock(
    kindergartenId: string,
    customDiscountId: string,
    childId: string,
    manager?: EntityManager,
  ): Promise<void> {
    const m = this.manager(manager);
    const scope = `discount:apply:${kindergartenId}:${childId}:${customDiscountId}`;
    await m.query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [
      scope,
    ]);
  }
}

/**
 * B22a T1 H16 helper. TypeORM 0.3.x's `EntityManager.query()` returns
 * different shapes depending on whether the SQL has `RETURNING`:
 *
 *   - Plain `SELECT ...` → `Array<row>`
 *   - `INSERT/UPDATE/DELETE ... RETURNING ...` → `[Array<row>, rowCount]`
 *     (a 2-element tuple — first element is the rows, second is the
 *     affected count)
 *
 * Without unwrapping, `result.length` against the tuple is always `2`,
 * which silently nukes any "did the WHERE match?" check downstream
 * (e.g. cap-respecting reservers always think they reserved). This
 * helper detects the tuple form and returns just the rows half.
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
