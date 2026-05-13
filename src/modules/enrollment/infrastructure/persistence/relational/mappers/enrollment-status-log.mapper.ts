import {
  EnrollmentStatusLogEntry,
  EnrollmentStatusLogEntryDraft,
} from '../../../../domain/types/enrollment-status-log-entry';
import { EnrollmentStatusValue } from '../../../../domain/value-objects/enrollment-status.vo';
import { EnrollmentStatusLogEntity } from '../entities/enrollment-status-log.entity';

/**
 * Column-only snapshot of `EnrollmentStatusLogEntity` — excludes the
 * `@ManyToOne` navigation properties so it satisfies TypeORM's
 * `QueryDeepPartialEntity` shape used by `repo.insert`. Without this filter,
 * the relation properties' types include the entire foreign aggregate which
 * trips strict structural matching.
 *
 * `created_at` is INTENTIONALLY omitted — see `draftToInsert` below.
 */
export interface EnrollmentStatusLogInsertColumns {
  enrollment_id: string;
  kindergarten_id: string;
  from_status: EnrollmentStatusValue | null;
  to_status: EnrollmentStatusValue;
  changed_by: string;
  comment: string | null;
}

/**
 * enrollment_status_log row ↔ POJO log-entry.
 */
export class EnrollmentStatusLogMapper {
  static toDomain(entity: EnrollmentStatusLogEntity): EnrollmentStatusLogEntry {
    return {
      id: entity.id,
      enrollmentId: entity.enrollment_id,
      kindergartenId: entity.kindergarten_id,
      fromStatus: entity.from_status,
      toStatus: entity.to_status,
      changedBy: entity.changed_by,
      comment: entity.comment,
      createdAt: entity.created_at,
    };
  }

  // `created_at` is NOT forwarded — the column defaults to `clock_timestamp()`
  // (migration `B22bEnrollmentLogClockTimestamp1778660000000`), which advances
  // per row even inside a single TX. Two transitions written back-to-back from
  // the service get distinct DB-assigned timestamps, so `ORDER BY created_at`
  // is stable. The Draft's `createdAt` is the domain layer's logical timestamp
  // — fine for in-memory fakes, but the persisted row is what readers see.
  static draftToInsert(
    draft: EnrollmentStatusLogEntryDraft,
  ): EnrollmentStatusLogInsertColumns {
    return {
      enrollment_id: draft.enrollmentId,
      kindergarten_id: draft.kindergartenId,
      from_status: draft.fromStatus,
      to_status: draft.toStatus,
      changed_by: draft.changedBy,
      comment: draft.comment,
    };
  }
}
