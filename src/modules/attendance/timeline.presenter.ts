import { TimelineEntry } from './domain/entities/timeline-entry.entity';
import {
  PagedTimelineResponseDto,
  TimelineEntryResponseDto,
} from './dto/timeline-entry.response';

export class TimelinePresenter {
  /**
   * Maps a timeline entry → response DTO. The optional `recordedByFullName`
   * overlay carries the author display name resolved from staff_members.id →
   * users.full_name (the row stores only `recorded_by`). Absent overlay →
   * `recorded_by_full_name` falls back to null. Mirrors
   * `ProgressNotePresenter.one`'s `mentorFullName` overlay.
   */
  static entry(
    e: TimelineEntry,
    recordedByFullName: string | null = null,
  ): TimelineEntryResponseDto {
    const s = e.toState();
    return {
      id: s.id,
      kindergartenId: s.kindergartenId,
      childId: s.childId,
      entryType: s.entryType,
      title: s.title,
      body: s.body,
      mediaUrls: s.mediaUrls,
      metadata: s.metadata,
      recordedBy: s.recordedBy,
      recorded_by_full_name: recordedByFullName,
      entryTime: s.entryTime.toISOString(),
      createdAt: s.createdAt.toISOString(),
    };
  }

  static paged(
    items: TimelineEntry[],
    nextCursor: string | null,
    recordedByNames?: Map<string, string | null>,
  ): PagedTimelineResponseDto {
    return {
      items: items.map((e) =>
        TimelinePresenter.entry(
          e,
          e.recordedBy ? (recordedByNames?.get(e.recordedBy) ?? null) : null,
        ),
      ),
      nextCursor,
    };
  }
}
