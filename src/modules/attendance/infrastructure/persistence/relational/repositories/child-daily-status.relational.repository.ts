import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { ChildDailyStatus } from '../../../../domain/entities/child-daily-status.entity';
import {
  ChildDailyStatusRepository,
  ListDailyStatusFilter,
} from '../../child-daily-status.repository';
import { ChildDailyStatusTypeOrmEntity } from '../entities/child-daily-status.typeorm.entity';
import { ChildDailyStatusMapper } from '../mappers/child-daily-status.mapper';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

@Injectable()
export class ChildDailyStatusRelationalRepository extends ChildDailyStatusRepository {
  constructor(
    @InjectRepository(ChildDailyStatusTypeOrmEntity)
    private readonly repo: Repository<ChildDailyStatusTypeOrmEntity>,
  ) {
    super();
  }

  async findByChildAndDate(
    kindergartenId: string,
    childId: string,
    date: string,
  ): Promise<ChildDailyStatus | null> {
    const row = await this.manager()
      .getRepository(ChildDailyStatusTypeOrmEntity)
      .findOne({
        where: {
          kindergarten_id: kindergartenId,
          child_id: childId,
          date,
        },
      });
    return row ? ChildDailyStatusMapper.toDomain(row) : null;
  }

  /**
   * INSERT … ON CONFLICT (child_id, date) DO UPDATE — atomic, never raises
   * 23505 inside the ambient transaction. Returns the post-write row via a
   * follow-up SELECT (so the unique-id of the row, generated server-side
   * when the conflict-update path runs against an existing pre-existing
   * row, is faithfully read back).
   */
  async upsert(
    kindergartenId: string,
    daily: ChildDailyStatus,
  ): Promise<ChildDailyStatus> {
    const m = this.manager();
    const state = daily.toState();
    await m.query(
      `INSERT INTO child_daily_status
         (id, kindergarten_id, child_id, date, status, note, set_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (child_id, date) DO UPDATE SET
         status = EXCLUDED.status,
         note = EXCLUDED.note,
         set_by = EXCLUDED.set_by,
         updated_at = EXCLUDED.updated_at`,
      [
        state.id,
        kindergartenId,
        state.childId,
        state.date,
        state.status,
        state.note,
        state.setBy,
        state.updatedAt,
      ],
    );
    const row = await m.getRepository(ChildDailyStatusTypeOrmEntity).findOne({
      where: {
        kindergarten_id: kindergartenId,
        child_id: state.childId,
        date: state.date,
      },
    });
    if (!row) {
      throw new Error(
        `child_daily_status_upsert_readback_failed:${state.childId}@${state.date}`,
      );
    }
    return ChildDailyStatusMapper.toDomain(row);
  }

  async save(
    kindergartenId: string,
    daily: ChildDailyStatus,
  ): Promise<ChildDailyStatus> {
    const m = this.manager();
    const state = daily.toState();
    await m.getRepository(ChildDailyStatusTypeOrmEntity).update(
      { id: state.id, kindergarten_id: kindergartenId },
      {
        status: state.status,
        note: state.note,
        set_by: state.setBy,
        updated_at: state.updatedAt,
      },
    );
    const row = await m.getRepository(ChildDailyStatusTypeOrmEntity).findOne({
      where: { id: state.id, kindergarten_id: kindergartenId },
    });
    if (!row) {
      throw new Error(
        `child_daily_status_save_readback_failed:${state.id}@${kindergartenId}`,
      );
    }
    return ChildDailyStatusMapper.toDomain(row);
  }

  async list(
    kindergartenId: string,
    filter: ListDailyStatusFilter,
  ): Promise<ChildDailyStatus[]> {
    const qb = this.manager()
      .getRepository(ChildDailyStatusTypeOrmEntity)
      .createQueryBuilder('ds')
      .where('ds.kindergarten_id = :kg', { kg: kindergartenId });
    if (filter.childId) {
      qb.andWhere('ds.child_id = :cid', { cid: filter.childId });
    }
    if (filter.groupId) {
      // INNER JOIN children to scope by current_group_id. Mirrors the
      // group resolution in AttendanceEvent.listByGroup — children
      // transferred mid-day are reported under their *current* group.
      qb.innerJoin('children', 'c', 'c.id = ds.child_id').andWhere(
        'c.current_group_id = :gid',
        { gid: filter.groupId },
      );
    }
    if (filter.from) {
      qb.andWhere('ds.date >= :from', { from: filter.from });
    }
    if (filter.to) {
      qb.andWhere('ds.date <= :to', { to: filter.to });
    }
    qb.orderBy('ds.date', 'DESC').addOrderBy('ds.child_id', 'ASC');
    const limit =
      filter.limit !== undefined
        ? Math.min(Math.max(filter.limit, 1), MAX_LIMIT)
        : DEFAULT_LIMIT;
    qb.limit(limit).offset(filter.offset ?? 0);
    const rows = await qb.getMany();
    return rows.map((r) => ChildDailyStatusMapper.toDomain(r));
  }

  private manager(): EntityManager {
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.repo.manager;
  }
}
