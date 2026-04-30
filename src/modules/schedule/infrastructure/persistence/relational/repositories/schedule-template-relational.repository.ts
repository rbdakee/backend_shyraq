import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  EntityManager,
  In,
  LessThanOrEqual,
  MoreThanOrEqual,
  Repository,
} from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { ScheduleTemplate } from '../../../../domain/entities/schedule-template.entity';
import { SlotConflictError } from '../../../../domain/errors/slot-conflict.error';
import {
  ListScheduleTemplatesFilter,
  ScheduleTemplateRepository,
} from '../../schedule-template.repository';
import { ScheduleTemplateEntity } from '../entities/schedule-template.entity';
import { ScheduleTemplateSlotEntity } from '../entities/schedule-template-slot.entity';
import { ScheduleTemplateMapper } from '../mappers/schedule-template.mapper';

interface PgError {
  code?: string;
  detail?: string;
  constraint?: string;
}

/**
 * TypeORM-backed adapter for ScheduleTemplateRepository. Aggregate is
 * persisted as `schedule_templates` + `schedule_template_slots` in one
 * transaction; `save()` reconciles the slot collection against the DB
 * (insert new, update existing, delete missing). PG error code 23505 on the
 * partial-unique slot index is mapped to `SlotConflictError`.
 *
 * Reads always pin the slots relation so the domain aggregate is fully
 * hydrated and can run its in-memory invariants.
 */
@Injectable()
export class ScheduleTemplateRelationalRepository extends ScheduleTemplateRepository {
  constructor(
    @InjectRepository(ScheduleTemplateEntity)
    private readonly repo: Repository<ScheduleTemplateEntity>,
  ) {
    super();
  }

  async create(
    kindergartenId: string,
    template: ScheduleTemplate,
  ): Promise<ScheduleTemplate> {
    const m = this.manager();
    const state = template.toState();
    await m.getRepository(ScheduleTemplateEntity).insert({
      id: state.id,
      kindergarten_id: kindergartenId,
      group_id: state.groupId,
      name: state.name,
      recurrence: state.recurrence,
      is_active: state.isActive,
      valid_from: state.validFrom,
      valid_until: state.validUntil,
      created_at: state.createdAt,
    });
    if (state.slots.length > 0) {
      try {
        await m.getRepository(ScheduleTemplateSlotEntity).insert(
          state.slots.map((s) => ({
            id: s.id,
            template_id: state.id,
            day_of_week: s.dayOfWeek,
            start_time: s.startTime,
            end_time: s.endTime,
            activity_name: s.activityName,
            location_id: s.locationId,
            description: s.description,
          })),
        );
      } catch (err) {
        this.mapSlotError(err, state.id);
        throw err;
      }
    }
    const reloaded = await this.findById(kindergartenId, state.id);
    if (reloaded === null) {
      throw new Error(
        `schedule_template_create_readback_failed:${state.id}@${kindergartenId}`,
      );
    }
    return reloaded;
  }

  async findById(
    kindergartenId: string,
    templateId: string,
  ): Promise<ScheduleTemplate | null> {
    const row = await this.manager()
      .getRepository(ScheduleTemplateEntity)
      .findOne({
        where: { id: templateId, kindergarten_id: kindergartenId },
        relations: ['slots'],
      });
    return row ? ScheduleTemplateMapper.toDomain(row) : null;
  }

  async list(
    kindergartenId: string,
    filter: ListScheduleTemplatesFilter,
  ): Promise<ScheduleTemplate[]> {
    const qb = this.manager()
      .getRepository(ScheduleTemplateEntity)
      .createQueryBuilder('t')
      .leftJoinAndSelect('t.slots', 's')
      .where('t.kindergarten_id = :kg', { kg: kindergartenId });
    if (filter.groupId !== undefined) {
      if (filter.groupId === null) {
        qb.andWhere('t.group_id IS NULL');
      } else {
        qb.andWhere('t.group_id = :gid', { gid: filter.groupId });
      }
    }
    if (filter.isActive !== undefined) {
      qb.andWhere('t.is_active = :active', { active: filter.isActive });
    }
    qb.orderBy('t.created_at', 'DESC');
    const rows = await qb.getMany();
    return rows.map((r) => ScheduleTemplateMapper.toDomain(r));
  }

  async listActiveValidOn(
    kindergartenId: string,
    date: Date,
  ): Promise<ScheduleTemplate[]> {
    const qb = this.manager()
      .getRepository(ScheduleTemplateEntity)
      .createQueryBuilder('t')
      .leftJoinAndSelect('t.slots', 's')
      .where('t.kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere('t.is_active = true')
      .andWhere('t.valid_from <= :d', { d: date })
      .andWhere('(t.valid_until IS NULL OR t.valid_until >= :d)', { d: date });
    const rows = await qb.getMany();
    return rows.map((r) => ScheduleTemplateMapper.toDomain(r));
  }

  async save(
    kindergartenId: string,
    template: ScheduleTemplate,
  ): Promise<ScheduleTemplate> {
    const m = this.manager();
    const state = template.toState();
    const tplRepo = m.getRepository(ScheduleTemplateEntity);
    const slotRepo = m.getRepository(ScheduleTemplateSlotEntity);

    await tplRepo.update(
      { id: state.id, kindergarten_id: kindergartenId },
      {
        group_id: state.groupId,
        name: state.name,
        recurrence: state.recurrence,
        is_active: state.isActive,
        valid_from: state.validFrom,
        valid_until: state.validUntil,
      },
    );

    // Reconcile slots: figure out which to insert / update / delete.
    const existing = await slotRepo.find({
      where: { template_id: state.id },
    });
    const existingById = new Map(existing.map((s) => [s.id, s]));
    const desiredById = new Map(state.slots.map((s) => [s.id, s]));

    const toInsert = state.slots.filter((s) => !existingById.has(s.id));
    const toUpdate = state.slots.filter((s) => existingById.has(s.id));
    const toDelete = existing
      .map((s) => s.id)
      .filter((id) => !desiredById.has(id));

    if (toDelete.length > 0) {
      await slotRepo.delete({ id: In(toDelete) });
    }
    for (const s of toUpdate) {
      await slotRepo.update(
        { id: s.id },
        {
          day_of_week: s.dayOfWeek,
          start_time: s.startTime,
          end_time: s.endTime,
          activity_name: s.activityName,
          location_id: s.locationId,
          description: s.description,
        },
      );
    }
    if (toInsert.length > 0) {
      try {
        await slotRepo.insert(
          toInsert.map((s) => ({
            id: s.id,
            template_id: state.id,
            day_of_week: s.dayOfWeek,
            start_time: s.startTime,
            end_time: s.endTime,
            activity_name: s.activityName,
            location_id: s.locationId,
            description: s.description,
          })),
        );
      } catch (err) {
        this.mapSlotError(err, state.id);
        throw err;
      }
    }

    const reloaded = await this.findById(kindergartenId, state.id);
    if (reloaded === null) {
      throw new Error(
        `schedule_template_save_readback_failed:${state.id}@${kindergartenId}`,
      );
    }
    return reloaded;
  }

  async delete(kindergartenId: string, templateId: string): Promise<void> {
    await this.manager()
      .getRepository(ScheduleTemplateEntity)
      .delete({ id: templateId, kindergarten_id: kindergartenId });
  }

  private mapSlotError(err: unknown, templateId: string): void {
    const pgErr =
      (err as { driverError?: PgError }).driverError ?? (err as PgError);
    if (pgErr?.code === '23505') {
      // The DB UNIQUE index is on (template_id, day_of_week, start_time).
      // We don't have the conflicting tuple in the error payload; surface a
      // generic conflict — domain-level checks already protect happy paths.
      throw new SlotConflictError(templateId, 'unknown', 'unknown');
    }
  }

  // unused helpers kept for completeness with date-range filters in future cron
  private static rangeWhere(
    from: Date | undefined,
    to: Date | undefined,
  ): Record<string, unknown> {
    const where: Record<string, unknown> = {};
    if (from !== undefined && to !== undefined) {
      where.starts_at = MoreThanOrEqual(from);
      // (TS/ORM trick — separate `LessThanOrEqual` via second key won't merge)
      where.ends_at = LessThanOrEqual(to);
    }
    return where;
  }

  private manager(): EntityManager {
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.repo.manager;
  }
}
