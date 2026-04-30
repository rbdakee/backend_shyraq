import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { TimelineEntry } from '../../../../domain/entities/timeline-entry.entity';
import {
  ListTimelineEntriesFilter,
  PagedTimelineEntries,
  TimelineEntryRepository,
} from '../../timeline-entry.repository';
import { TimelineEntryTypeOrmEntity } from '../entities/timeline-entry.typeorm.entity';
import { TimelineEntryMapper } from '../mappers/timeline-entry.mapper';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Cursor format: `<entry_time_iso>|<id>` base64-encoded. The composite
 * (entry_time DESC, id DESC) ensures stable ordering when multiple entries
 * share the same timestamp.
 */
function encodeCursor(entryTime: Date, id: string): string {
  return Buffer.from(`${entryTime.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { entryTime: Date; id: string } | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const sep = raw.lastIndexOf('|');
    if (sep < 0) return null;
    const ts = raw.slice(0, sep);
    const id = raw.slice(sep + 1);
    const d = new Date(ts);
    if (isNaN(d.getTime()) || !id) return null;
    return { entryTime: d, id };
  } catch {
    return null;
  }
}

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

  async findByChild(
    kindergartenId: string,
    childId: string,
    opts: ListTimelineEntriesFilter,
  ): Promise<PagedTimelineEntries> {
    const limit = clampLimit(opts.limit);
    // Fetch one extra row to detect if there is a next page.
    const fetchCount = limit + 1;

    const qb = this.manager()
      .getRepository(TimelineEntryTypeOrmEntity)
      .createQueryBuilder('t')
      .where('t.kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere('t.child_id = :cid', { cid: childId });

    if (opts.from !== undefined) {
      qb.andWhere('t.entry_time >= :from', { from: opts.from });
    }
    if (opts.to !== undefined) {
      qb.andWhere('t.entry_time < :to', { to: opts.to });
    }

    if (opts.cursor) {
      const decoded = decodeCursor(opts.cursor);
      if (decoded) {
        // Keyset pagination: rows where (entry_time, id) is strictly before
        // the cursor position (DESC ordering → "earlier than cursor").
        qb.andWhere(
          '(t.entry_time < :ct OR (t.entry_time = :ct AND t.id < :cid2))',
          { ct: decoded.entryTime, cid2: decoded.id },
        );
      }
    }

    qb.orderBy('t.entry_time', 'DESC').addOrderBy('t.id', 'DESC');
    qb.limit(fetchCount);

    const rows = await qb.getMany();
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;

    let nextCursor: string | null = null;
    if (hasMore && items.length > 0) {
      const last = items[items.length - 1];
      nextCursor = encodeCursor(last.entry_time, last.id);
    }

    return {
      items: items.map((r) => TimelineEntryMapper.toDomain(r)),
      nextCursor,
    };
  }

  async update(
    kindergartenId: string,
    entry: TimelineEntry,
  ): Promise<TimelineEntry> {
    const m = this.manager();
    const state = entry.toState();
    await m.getRepository(TimelineEntryTypeOrmEntity).update(
      { id: state.id, kindergarten_id: kindergartenId },
      {
        title: state.title,
        body: state.body,
        media_urls: state.mediaUrls,
        metadata: state.metadata as unknown as undefined,
        entry_time: state.entryTime,
      },
    );
    const row = await m.getRepository(TimelineEntryTypeOrmEntity).findOne({
      where: { id: state.id, kindergarten_id: kindergartenId },
    });
    if (!row) {
      throw new Error(
        `timeline_entry_update_readback_failed:${state.id}@${kindergartenId}`,
      );
    }
    return TimelineEntryMapper.toDomain(row);
  }

  async delete(kindergartenId: string, entryId: string): Promise<void> {
    await this.manager()
      .getRepository(TimelineEntryTypeOrmEntity)
      .delete({ id: entryId, kindergarten_id: kindergartenId });
  }

  private manager(): EntityManager {
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.repo.manager;
  }
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined || raw <= 0) return DEFAULT_LIMIT;
  return Math.min(raw, MAX_LIMIT);
}
