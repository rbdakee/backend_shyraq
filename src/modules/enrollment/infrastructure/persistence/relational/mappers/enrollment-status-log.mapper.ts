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
 */
export interface EnrollmentStatusLogInsertColumns {
  enrollment_id: string;
  kindergarten_id: string;
  from_status: EnrollmentStatusValue | null;
  to_status: EnrollmentStatusValue;
  changed_by: string;
  comment: string | null;
  created_at: Date;
}

/**
 * enrollment_status_log row ↔ POJO log-entry. Both shapes have flat optional
 * fields, so this is a straight copy. The Draft variant (id-less) feeds
 * `repo.insert` in the relational repo; the persisted variant comes back out
 * via `toDomain` for `listForEnrollment`.
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
      created_at: draft.createdAt,
    };
  }
}
