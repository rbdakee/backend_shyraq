import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { AttendanceEvent } from '../../../../domain/entities/attendance-event.entity';
import {
  AttendanceEventRepository,
  ListAttendanceEventsByChildFilter,
  ListAttendanceEventsByGroupFilter,
} from '../../attendance-event.repository';
import { AttendanceEventTypeOrmEntity } from '../entities/attendance-event.typeorm.entity';
import { AttendanceEventMapper } from '../mappers/attendance-event.mapper';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

@Injectable()
export class AttendanceEventRelationalRepository extends AttendanceEventRepository {
  constructor(
    @InjectRepository(AttendanceEventTypeOrmEntity)
    private readonly repo: Repository<AttendanceEventTypeOrmEntity>,
  ) {
    super();
  }

  async create(
    kindergartenId: string,
    event: AttendanceEvent,
  ): Promise<AttendanceEvent> {
    const m = this.manager();
    const state = event.toState();
    await m.getRepository(AttendanceEventTypeOrmEntity).insert({
      id: state.id,
      kindergarten_id: kindergartenId,
      child_id: state.childId,
      event_type: state.eventType,
      method: state.method,
      recorded_by: state.recordedBy,
      pickup_user_id: state.pickupUserId,
      pickup_request_id: state.pickupRequestId,
      notes: state.notes,
      recorded_at: state.recordedAt,
      created_at: state.createdAt,
    });
    const row = await m.getRepository(AttendanceEventTypeOrmEntity).findOne({
      where: { id: state.id, kindergarten_id: kindergartenId },
    });
    if (!row) {
      throw new Error(
        `attendance_event_create_readback_failed:${state.id}@${kindergartenId}`,
      );
    }
    return AttendanceEventMapper.toDomain(row);
  }

  async findById(
    kindergartenId: string,
    eventId: string,
  ): Promise<AttendanceEvent | null> {
    const row = await this.manager()
      .getRepository(AttendanceEventTypeOrmEntity)
      .findOne({ where: { id: eventId, kindergarten_id: kindergartenId } });
    return row ? AttendanceEventMapper.toDomain(row) : null;
  }

  async update(
    kindergartenId: string,
    event: AttendanceEvent,
  ): Promise<AttendanceEvent> {
    const m = this.manager();
    const state = event.toState();
    await m.getRepository(AttendanceEventTypeOrmEntity).update(
      { id: state.id, kindergarten_id: kindergartenId },
      {
        recorded_at: state.recordedAt,
        notes: state.notes,
        pickup_user_id: state.pickupUserId,
      },
    );
    const row = await m.getRepository(AttendanceEventTypeOrmEntity).findOne({
      where: { id: state.id, kindergarten_id: kindergartenId },
    });
    if (!row) {
      throw new Error(
        `attendance_event_update_readback_failed:${state.id}@${kindergartenId}`,
      );
    }
    return AttendanceEventMapper.toDomain(row);
  }

  async listByChild(
    kindergartenId: string,
    childId: string,
    filter: ListAttendanceEventsByChildFilter,
  ): Promise<AttendanceEvent[]> {
    const qb = this.manager()
      .getRepository(AttendanceEventTypeOrmEntity)
      .createQueryBuilder('e')
      .where('e.kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere('e.child_id = :cid', { cid: childId });
    if (filter.from !== undefined) {
      qb.andWhere('e.recorded_at >= :from', { from: filter.from });
    }
    if (filter.to !== undefined) {
      qb.andWhere('e.recorded_at < :to', { to: filter.to });
    }
    if (filter.eventType !== undefined) {
      qb.andWhere('e.event_type = :et', { et: filter.eventType });
    }
    qb.orderBy('e.recorded_at', 'DESC');
    qb.limit(clampLimit(filter.limit));
    qb.offset(filter.offset ?? 0);
    const rows = await qb.getMany();
    return rows.map((r) => AttendanceEventMapper.toDomain(r));
  }

  async listByGroup(
    kindergartenId: string,
    filter: ListAttendanceEventsByGroupFilter,
  ): Promise<AttendanceEvent[]> {
    // Group resolution joins through children.current_group_id. A child who
    // was transferred mid-day is reported under the *current* group; the spec
    // (B8 plan §"Service contract") explicitly chose this over the group at
    // the moment of recording so live dashboards stay accurate.
    const qb = this.manager()
      .getRepository(AttendanceEventTypeOrmEntity)
      .createQueryBuilder('e')
      .innerJoin('children', 'c', 'c.id = e.child_id')
      .where('e.kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere('c.current_group_id = :gid', { gid: filter.groupId });
    if (filter.from !== undefined) {
      qb.andWhere('e.recorded_at >= :from', { from: filter.from });
    }
    if (filter.to !== undefined) {
      qb.andWhere('e.recorded_at < :to', { to: filter.to });
    }
    if (filter.eventType !== undefined) {
      qb.andWhere('e.event_type = :et', { et: filter.eventType });
    }
    qb.orderBy('e.recorded_at', 'DESC');
    qb.limit(clampLimit(filter.limit));
    qb.offset(filter.offset ?? 0);
    const rows = await qb.getMany();
    return rows.map((r) => AttendanceEventMapper.toDomain(r));
  }

  private manager(): EntityManager {
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.repo.manager;
  }
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  if (raw <= 0) return DEFAULT_LIMIT;
  return Math.min(raw, MAX_LIMIT);
}
