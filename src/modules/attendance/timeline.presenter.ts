import { TimelineEntry } from './domain/entities/timeline-entry.entity';
import {
  PagedTimelineResponseDto,
  TimelineEntryResponseDto,
} from './dto/timeline-entry.response';

export class TimelinePresenter {
  static entry(e: TimelineEntry): TimelineEntryResponseDto {
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
      entryTime: s.entryTime.toISOString(),
      createdAt: s.createdAt.toISOString(),
    };
  }

  static paged(
    items: TimelineEntry[],
    nextCursor: string | null,
  ): PagedTimelineResponseDto {
    return {
      items: items.map((e) => TimelinePresenter.entry(e)),
      nextCursor,
    };
  }
}
