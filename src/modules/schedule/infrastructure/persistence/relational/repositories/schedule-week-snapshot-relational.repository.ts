import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { ScheduleWeekSnapshot } from '../../../../domain/entities/schedule-week-snapshot.entity';
import { WeekSnapshotAlreadyExistsError } from '../../../../domain/errors/week-snapshot-already-exists.error';
import {
  ListScheduleWeekSnapshotsFilter,
  ScheduleWeekSnapshotRepository,
} from '../../schedule-week-snapshot.repository';
import { ScheduleWeekSnapshotEntity } from '../entities/schedule-week-snapshot.entity';
import { ScheduleWeekSnapshotMapper } from '../mappers/schedule-week-snapshot.mapper';

interface PgError {
  code?: string;
}

@Injectable()
export class ScheduleWeekSnapshotRelationalRepository extends ScheduleWeekSnapshotRepository {
  constructor(
    @InjectRepository(ScheduleWeekSnapshotEntity)
    private readonly repo: Repository<ScheduleWeekSnapshotEntity>,
  ) {
    super();
  }

  async create(
    kindergartenId: string,
    snapshot: ScheduleWeekSnapshot,
  ): Promise<ScheduleWeekSnapshot> {
    const m = this.manager();
    const state = snapshot.toState();
    try {
      await m.getRepository(ScheduleWeekSnapshotEntity).insert({
        id: state.id,
        kindergarten_id: kindergartenId,
        group_id: state.groupId,
        week_start_date: state.weekStartDate,
        source: state.source,
        copied_from: state.copiedFrom,
        created_at: state.createdAt,
      });
    } catch (err) {
      const pg =
        (err as { driverError?: PgError }).driverError ?? (err as PgError);
      if (pg?.code === '23505') {
        throw new WeekSnapshotAlreadyExistsError(
          state.groupId,
          state.weekStartDate.toISOString().slice(0, 10),
        );
      }
      throw err;
    }
    const row = await m.getRepository(ScheduleWeekSnapshotEntity).findOne({
      where: { id: state.id, kindergarten_id: kindergartenId },
    });
    if (!row) {
      throw new Error(
        `schedule_week_snapshot_create_readback_failed:${state.id}@${kindergartenId}`,
      );
    }
    return ScheduleWeekSnapshotMapper.toDomain(row);
  }

  async findByGroupAndWeek(
    kindergartenId: string,
    groupId: string,
    weekStartDate: Date,
  ): Promise<ScheduleWeekSnapshot | null> {
    const row = await this.manager()
      .getRepository(ScheduleWeekSnapshotEntity)
      .findOne({
        where: {
          kindergarten_id: kindergartenId,
          group_id: groupId,
          week_start_date: weekStartDate,
        },
      });
    return row ? ScheduleWeekSnapshotMapper.toDomain(row) : null;
  }

  async list(
    kindergartenId: string,
    filter: ListScheduleWeekSnapshotsFilter,
  ): Promise<ScheduleWeekSnapshot[]> {
    const qb = this.manager()
      .getRepository(ScheduleWeekSnapshotEntity)
      .createQueryBuilder('s')
      .where('s.kindergarten_id = :kg', { kg: kindergartenId });
    if (filter.groupId !== undefined) {
      qb.andWhere('s.group_id = :gid', { gid: filter.groupId });
    }
    if (filter.from !== undefined) {
      qb.andWhere('s.week_start_date >= :from', { from: filter.from });
    }
    if (filter.to !== undefined) {
      qb.andWhere('s.week_start_date <= :to', { to: filter.to });
    }
    qb.orderBy('s.week_start_date', 'ASC');
    const rows = await qb.getMany();
    return rows.map((r) => ScheduleWeekSnapshotMapper.toDomain(r));
  }

  private manager(): EntityManager {
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.repo.manager;
  }
}
