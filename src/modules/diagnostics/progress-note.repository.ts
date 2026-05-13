import { ProgressNote } from './domain/entities/progress-note.entity';

export interface ListProgressNotesFilter {
  childId?: string;
  mentorId?: string;
  /** Inclusive lower bound on `noted_at`. */
  from?: Date;
  /** Inclusive upper bound on `noted_at`. */
  to?: Date;
  cursor?: string;
  limit: number;
}

export interface ProgressNoteListResult {
  items: ProgressNote[];
  nextCursor: string | null;
}

export abstract class ProgressNoteRepository {
  abstract create(note: ProgressNote): Promise<ProgressNote>;

  abstract findById(kgId: string, id: string): Promise<ProgressNote | null>;

  /**
   * Conditional UPDATE for optimistic-lock race protection (B22a T4).
   * When `expectedRowVersion` is supplied, the implementation issues
   * `WHERE row_version = $expectedRowVersion` and bumps `row_version`
   * by 1 in the same statement. Throws `OptimisticLockError` (HTTP
   * 409 `optimistic_lock_conflict`) if zero rows match.
   */
  abstract update(
    note: ProgressNote,
    expectedRowVersion?: number,
  ): Promise<ProgressNote>;

  /**
   * DELETE WHERE id AND kindergarten_id. Returns true if a row was removed,
   * false otherwise (404 in service layer).
   */
  abstract delete(kgId: string, id: string): Promise<boolean>;

  abstract list(
    kgId: string,
    filters: ListProgressNotesFilter,
  ): Promise<ProgressNoteListResult>;
}
