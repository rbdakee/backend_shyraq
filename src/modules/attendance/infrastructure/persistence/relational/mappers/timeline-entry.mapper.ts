import { TimelineEntry } from '../../../../domain/entities/timeline-entry.entity';
import { TimelineEntryTypeOrmEntity } from '../entities/timeline-entry.typeorm.entity';

export class TimelineEntryMapper {
  static toDomain(row: TimelineEntryTypeOrmEntity): TimelineEntry {
    return TimelineEntry.hydrate({
      id: row.id,
      kindergartenId: row.kindergarten_id,
      childId: row.child_id,
      entryType: row.entry_type,
      title: row.title,
      body: row.body,
      mediaUrls: row.media_urls,
      metadata: row.metadata,
      recordedBy: row.recorded_by,
      entryTime:
        row.entry_time instanceof Date
          ? row.entry_time
          : new Date(row.entry_time),
      createdAt:
        row.created_at instanceof Date
          ? row.created_at
          : new Date(row.created_at),
      sourceEventId: row.source_event_id,
    });
  }
}
