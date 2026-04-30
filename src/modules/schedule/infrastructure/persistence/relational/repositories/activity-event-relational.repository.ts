import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { ActivityEvent } from '../../../../domain/entities/activity-event.entity';
import {
  ActivityEventRepository,
  ListActivityEventsFilter,
} from '../../activity-event.repository';
import { ActivityEventEntity } from '../entities/activity-event.entity';
import { ActivityEventMapper } from '../mappers/activity-event.mapper';

@Injectable()
export class ActivityEventRelationalRepository extends ActivityEventRepository {
  constructor(
    @InjectRepository(ActivityEventEntity)
    private readonly repo: Repository<ActivityEventEntity>,
  ) {
    super();
  }

  async create(
    kindergartenId: string,
    event: ActivityEvent,
  ): Promise<ActivityEvent> {
    const m = this.manager();
    const state = event.toState();
    await m.getRepository(ActivityEventEntity).insert({
      id: state.id,
      kindergarten_id: kindergartenId,
      group_id: state.groupId,
      template_slot_id: state.templateSlotId,
      activity_name: state.activityName,
      location_id: state.locationId,
      starts_at: state.startsAt,
      ends_at: state.endsAt,
      status: state.status,
      created_by: state.createdBy,
      notes: state.notes,
      created_at: state.createdAt,
      updated_at: state.updatedAt,
    });
    const row = await m.getRepository(ActivityEventEntity).findOne({
      where: { id: state.id, kindergarten_id: kindergartenId },
    });
    if (!row) {
      throw new Error(
        `activity_event_create_readback_failed:${state.id}@${kindergartenId}`,
      );
    }
    return ActivityEventMapper.toDomain(row);
  }

  async createMany(
    kindergartenId: string,
    events: ActivityEvent[],
  ): Promise<ActivityEvent[]> {
    if (events.length === 0) return [];
    const m = this.manager();
    const rows = events.map((e) => {
      const s = e.toState();
      return {
        id: s.id,
        kindergarten_id: kindergartenId,
        group_id: s.groupId,
        template_slot_id: s.templateSlotId,
        activity_name: s.activityName,
        location_id: s.locationId,
        starts_at: s.startsAt,
        ends_at: s.endsAt,
        status: s.status,
        created_by: s.createdBy,
        notes: s.notes,
        created_at: s.createdAt,
        updated_at: s.updatedAt,
      };
    });
    await m.getRepository(ActivityEventEntity).insert(rows);
    return events;
  }

  async findById(
    kindergartenId: string,
    eventId: string,
  ): Promise<ActivityEvent | null> {
    const row = await this.manager()
      .getRepository(ActivityEventEntity)
      .findOne({
        where: { id: eventId, kindergarten_id: kindergartenId },
      });
    return row ? ActivityEventMapper.toDomain(row) : null;
  }

  async update(
    kindergartenId: string,
    event: ActivityEvent,
  ): Promise<ActivityEvent> {
    const m = this.manager();
    const state = event.toState();
    await m.getRepository(ActivityEventEntity).update(
      { id: state.id, kindergarten_id: kindergartenId },
      {
        activity_name: state.activityName,
        location_id: state.locationId,
        starts_at: state.startsAt,
        ends_at: state.endsAt,
        status: state.status,
        notes: state.notes,
        updated_at: state.updatedAt,
      },
    );
    const row = await m.getRepository(ActivityEventEntity).findOne({
      where: { id: state.id, kindergarten_id: kindergartenId },
    });
    if (!row) {
      throw new Error(
        `activity_event_update_readback_failed:${state.id}@${kindergartenId}`,
      );
    }
    return ActivityEventMapper.toDomain(row);
  }

  async list(
    kindergartenId: string,
    filter: ListActivityEventsFilter,
  ): Promise<ActivityEvent[]> {
    const qb = this.manager()
      .getRepository(ActivityEventEntity)
      .createQueryBuilder('e')
      .where('e.kindergarten_id = :kg', { kg: kindergartenId });
    if (filter.groupId !== undefined) {
      qb.andWhere('e.group_id = :gid', { gid: filter.groupId });
    }
    if (filter.from !== undefined) {
      qb.andWhere('e.starts_at >= :from', { from: filter.from });
    }
    if (filter.to !== undefined) {
      qb.andWhere('e.starts_at < :to', { to: filter.to });
    }
    if (filter.status !== undefined) {
      qb.andWhere('e.status = :st', { st: filter.status });
    }
    qb.orderBy('e.starts_at', 'ASC');
    const rows = await qb.getMany();
    return rows.map((r) => ActivityEventMapper.toDomain(r));
  }

  async delete(kindergartenId: string, eventId: string): Promise<void> {
    await this.manager()
      .getRepository(ActivityEventEntity)
      .delete({ id: eventId, kindergarten_id: kindergartenId });
  }

  private manager(): EntityManager {
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.repo.manager;
  }
}
