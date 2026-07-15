import { TimelineEntry } from '../../domain/entities/timeline-entry.entity';

export interface ListTimelineEntriesFilter {
  limit?: number;
  /** Opaque cursor produced by the previous page (base64-encoded ISO|id). */
  cursor?: string;
  /** Inclusive lower bound on entry_time. */
  from?: Date;
  /** Exclusive upper bound on entry_time. */
  to?: Date;
}

export interface PagedTimelineEntries {
  items: TimelineEntry[];
  /** null when there are no more pages. */
  nextCursor: string | null;
}

/**
 * Port over `timeline_entries`.
 *
 * T3 declared `create` + `findById`. T4 adds the full CRUD and paged list
 * needed by the standalone timeline endpoints.
 */
export abstract class TimelineEntryRepository {
  abstract create(
    kindergartenId: string,
    entry: TimelineEntry,
  ): Promise<TimelineEntry>;

  abstract findById(
    kindergartenId: string,
    entryId: string,
  ): Promise<TimelineEntry | null>;

  /**
   * Finds the check_in / check_out entry mirroring the given attendance
   * event, so the admin attendance cascade can re-point or remove it.
   *
   * Returns null for entries written before `source_event_id` existed where
   * the migration's backfill could not match unambiguously — the cascade
   * treats that as "nothing to cascade" rather than failing the correction.
   */
  abstract findBySourceEventId(
    kindergartenId: string,
    sourceEventId: string,
  ): Promise<TimelineEntry | null>;

  abstract findByChild(
    kindergartenId: string,
    childId: string,
    opts: ListTimelineEntriesFilter,
  ): Promise<PagedTimelineEntries>;

  abstract update(
    kindergartenId: string,
    entry: TimelineEntry,
  ): Promise<TimelineEntry>;

  abstract delete(kindergartenId: string, entryId: string): Promise<void>;
}
