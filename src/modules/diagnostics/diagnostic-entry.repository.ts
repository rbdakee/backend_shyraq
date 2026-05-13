import { DiagnosticEntry } from './domain/entities/diagnostic-entry.entity';

export interface ListDiagnosticEntriesFilter {
  childId?: string;
  specialistId?: string;
  templateId?: string;
  /** Inclusive lower bound on `assessment_date` (calendar date). */
  from?: Date;
  /** Inclusive upper bound on `assessment_date`. */
  to?: Date;
  cursor?: string;
  limit: number;
}

export interface DiagnosticEntryListResult {
  items: DiagnosticEntry[];
  nextCursor: string | null;
}

/**
 * Latest-per-child summary used by `MyTodosService`. The relational impl
 * issues a single SQL with `JOIN diagnostic_templates ON specialist_type`
 * + `DISTINCT ON (child_id) ... ORDER BY child_id, assessment_date DESC`
 * so we never N+1 across active children.
 */
export interface LatestDiagnosticEntryRow {
  childId: string;
  assessmentDate: Date;
}

export abstract class DiagnosticEntryRepository {
  abstract create(entry: DiagnosticEntry): Promise<DiagnosticEntry>;

  abstract findById(kgId: string, id: string): Promise<DiagnosticEntry | null>;

  /**
   * Conditional UPDATE for optimistic-lock race protection (B22a T4).
   * When `expectedRowVersion` is supplied, the implementation issues
   * `WHERE row_version = $expectedRowVersion` and bumps `row_version`
   * by 1 in the same statement. Throws `OptimisticLockError` (HTTP
   * 409 `optimistic_lock_conflict`) if zero rows match.
   */
  abstract update(
    entry: DiagnosticEntry,
    expectedRowVersion?: number,
  ): Promise<DiagnosticEntry>;

  abstract list(
    kgId: string,
    filters: ListDiagnosticEntriesFilter,
  ): Promise<DiagnosticEntryListResult>;

  /**
   * Returns the latest `(child_id, assessment_date)` per active (non-archived)
   * child, restricted to entries authored under templates whose
   * `specialist_type = $specialistType`. Children without an entry are NOT
   * present in the map — `MyTodosService` infers "never assessed" from
   * absence.
   */
  abstract findLatestPerActiveChildBySpecialistType(
    kgId: string,
    specialistType: string,
  ): Promise<Map<string, LatestDiagnosticEntryRow>>;
}
