import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { ActivityEvent } from '../../../../domain/entities/activity-event.entity';
import { ActivityEventStatusValue } from '../../../../domain/value-objects/activity-event-status.vo';
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
      origin: state.origin,
      activity_name: state.activityName,
      category: state.category,
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
        origin: s.origin,
        activity_name: s.activityName,
        category: s.category,
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
        category: state.category,
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

  async updateWithExpectedStatus(
    kindergartenId: string,
    event: ActivityEvent,
    expectedOldStatus: ActivityEventStatusValue,
  ): Promise<boolean> {
    const m = this.manager();
    const state = event.toState();
    // Conditional UPDATE: only commit the new status (and the rest of the
    // mutated columns) when the row's current status still matches
    // `expectedOldStatus`. If a concurrent transition already moved the row,
    // `affected = 0` and the service raises EventTransitionConflictError.
    const result = await m
      .getRepository(ActivityEventEntity)
      .createQueryBuilder()
      .update(ActivityEventEntity)
      .set({
        activity_name: state.activityName,
        location_id: state.locationId,
        starts_at: state.startsAt,
        ends_at: state.endsAt,
        status: state.status,
        notes: state.notes,
        updated_at: state.updatedAt,
      })
      .where('id = :id', { id: state.id })
      .andWhere('kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere('status = :expected', { expected: expectedOldStatus })
      .execute();
    return (result.affected ?? 0) > 0;
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

  async deleteTemplateScheduledInRange(
    kindergartenId: string,
    groupId: string,
    from: Date,
    to: Date,
    after: Date,
  ): Promise<number> {
    // Single DELETE — no read-then-delete. `origin = 'template'` is what reaches
    // the orphans a template edit left behind (their `template_slot_id` was
    // NULLed by the FK's ON DELETE SET NULL), while leaving 'adhoc' rows alone.
    const result = await this.manager()
      .getRepository(ActivityEventEntity)
      .createQueryBuilder()
      .delete()
      .from(ActivityEventEntity)
      .where('kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere('group_id = :gid', { gid: groupId })
      .andWhere('origin = :origin', { origin: 'template' })
      .andWhere('status = :status', { status: 'scheduled' })
      .andWhere('starts_at >= :from', { from })
      .andWhere('starts_at < :to', { to })
      .andWhere('starts_at > :after', { after })
      .execute();
    return result.affected ?? 0;
  }

  private manager(): EntityManager {
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.repo.manager;
  }
}
