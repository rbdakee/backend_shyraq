import { Enrollment } from '../../domain/entities/enrollment.entity';
import { EnrollmentStatusValue } from '../../domain/value-objects/enrollment-status.vo';

export interface EnrollmentListFilter {
  /** Exact match on the enrollment status enum. */
  status?: EnrollmentStatusValue;
  /**
   * Free-text query. Matches `child_name` ILIKE `%q%` OR `contact_phone` =
   * `q` (exact). Plan §4.1: "substring on child_name + exact on
   * contact_phone — separate matchers". Implementations OR the two clauses
   * inside a single WHERE group.
   */
  q?: string;
  /** 1-based page index. */
  page: number;
  /** Page size; the controller clamps to a sane upper bound. */
  limit: number;
}

export interface EnrollmentListResult {
  items: Enrollment[];
  total: number;
}

/**
 * Port over the `enrollments` table. Service.ts always passes
 * `kindergartenId` explicitly — RLS is defense-in-depth, not the contract
 * boundary. Methods return/accept domain `Enrollment`, never TypeORM
 * entities.
 */
export abstract class EnrollmentRepository {
  abstract create(
    kindergartenId: string,
    enrollment: Enrollment,
  ): Promise<Enrollment>;

  abstract findById(
    kindergartenId: string,
    enrollmentId: string,
  ): Promise<Enrollment | null>;

  abstract update(
    kindergartenId: string,
    enrollment: Enrollment,
  ): Promise<Enrollment>;

  /**
   * Conditional UPDATE for status transitions: writes the enrollment row
   * only when the row's current `status` still matches `expectedOldStatus`.
   * Returns `true` when 1 row was updated, `false` when the row was moved
   * concurrently (loser of a race).
   *
   * Critical for the `card_created` edge: the loser's `createChild` +
   * `inviteGuardian` writes still happen earlier in the same ambient TX —
   * the service must throw `EnrollmentTransitionConflictError` on `false`
   * so the surrounding TX rolls back the orphan child + guardian rows.
   */
  abstract updateWithExpectedStatus(
    kindergartenId: string,
    enrollment: Enrollment,
    expectedOldStatus: EnrollmentStatusValue,
  ): Promise<boolean>;

  abstract list(
    kindergartenId: string,
    filter: EnrollmentListFilter,
  ): Promise<EnrollmentListResult>;

  // ── B-DASH — Dashboard summary aggregate ──────────────────────────────

  /**
   * COUNT of enrollments in the active funnel — `status IN ('new',
   * 'in_processing','waitlist')` (locked product decision §0#2: the whole
   * active pipeline, not just the literal `in_processing`). Default stub so
   * older in-memory test fakes compile; the relational impl overrides with a
   * real COUNT query.
   */
  countInProcessing(_kindergartenId: string): Promise<number> {
    return Promise.resolve(0);
  }
}
