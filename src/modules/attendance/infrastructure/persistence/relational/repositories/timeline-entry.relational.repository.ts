import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { TimelineEntry } from '../../../../domain/entities/timeline-entry.entity';
import { TimelineEntryRepository } from '../../timeline-entry.repository';
import { TimelineEntryTypeOrmEntity } from '../entities/timeline-entry.typeorm.entity';
import { TimelineEntryMapper } from '../mappers/timeline-entry.mapper';

@Injectable()
export class TimelineEntryRelationalRepository extends TimelineEntryRepository {
  constructor(
    @InjectRepository(TimelineEntryTypeOrmEntity)
    private readonly repo: Repository<TimelineEntryTypeOrmEntity>,
  ) {
    super();
  }

  async create(
    kindergartenId: string,
    entry: TimelineEntry,
  ): Promise<TimelineEntry> {
    const m = this.manager();
    const state = entry.toState();
    await m.getRepository(TimelineEntryTypeOrmEntity).insert({
      id: state.id,
      kindergarten_id: kindergartenId,
      child_id: state.childId,
      entry_type: state.entryType,
      title: state.title,
      body: state.body,
      media_urls: state.mediaUrls,
      // jsonb column — TypeORM's QueryDeepPartial type requires a cast.
      metadata: state.metadata as unknown as undefined,
      recorded_by: state.recordedBy,
      entry_time: state.entryTime,
      created_at: state.createdAt,
    });
    const row = await m.getRepository(TimelineEntryTypeOrmEntity).findOne({
      where: { id: state.id, kindergarten_id: kindergartenId },
    });
    if (!row) {
      throw new Error(
        `timeline_entry_create_readback_failed:${state.id}@${kindergartenId}`,
      );
    }
    return TimelineEntryMapper.toDomain(row);
  }

  async findById(
    kindergartenId: string,
    entryId: string,
  ): Promise<TimelineEntry | null> {
    const row = await this.manager()
      .getRepository(TimelineEntryTypeOrmEntity)
      .findOne({ where: { id: entryId, kindergarten_id: kindergartenId } });
    return row ? TimelineEntryMapper.toDomain(row) : null;
  }

  private manager(): EntityManager {
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.repo.manager;
  }
}
