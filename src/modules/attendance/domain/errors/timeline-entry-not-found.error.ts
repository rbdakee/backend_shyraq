import { NotFoundError } from '@/shared-kernel/domain/errors';

/**
 * 404 — the timeline_entries row does not exist (or RLS hides it). Used by
 * T4's standalone TimelineService; T3 doesn't throw it directly but the
 * error class lives in the attendance module because timeline_entries
 * belongs to the same B8 aggregate.
 */
export class TimelineEntryNotFoundError extends NotFoundError {
  public readonly code = 'timeline_entry_not_found' as const;

  constructor(public readonly entryId: string) {
    super('timeline_entry', entryId);
  }
}
