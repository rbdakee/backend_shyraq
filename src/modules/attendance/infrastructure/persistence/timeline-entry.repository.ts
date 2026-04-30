import { TimelineEntry } from '../../domain/entities/timeline-entry.entity';

/**
 * Port over `timeline_entries`. T3 only needs `create` (the check-in/out
 * timeline rows are written inside the atomic flow) and `findById` (for T4's
 * standalone TimelineService — declared here to keep one canonical port).
 *
 * Full CRUD (list/update/delete) is added in T4 alongside the standalone
 * timeline endpoints.
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
}
