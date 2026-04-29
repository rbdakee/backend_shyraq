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

  abstract list(
    kindergartenId: string,
    filter: EnrollmentListFilter,
  ): Promise<EnrollmentListResult>;
}
