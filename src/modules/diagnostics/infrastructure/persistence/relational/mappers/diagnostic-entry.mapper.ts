import {
  DiagnosticEntry,
  DiagnosticEntryState,
} from '../../../../domain/entities/diagnostic-entry.entity';
import { DiagnosticEntryRelationalEntity } from '../entities/diagnostic-entry.entity';

/**
 * Domain ↔ TypeORM mapper for `diagnostic_entries`. PG returns the
 * `assessment_date` column as a `string` (`YYYY-MM-DD`) — we coerce to a
 * JS `Date` here so the domain layer stays type-stable. Going the other
 * direction we let TypeORM bind the `Date` directly; PG narrows to date.
 */
function coerceAssessmentDate(raw: unknown): Date {
  if (raw instanceof Date) return raw;
  if (typeof raw === 'string') {
    // Avoid timezone drift: anchor at midnight UTC. The domain compares
    // only via `Asia/Almaty` formatter, so the absolute instant is fine.
    return new Date(`${raw}T00:00:00.000Z`);
  }
  // Fallthrough: let the domain invariant catch the bad shape.
  return new Date(NaN);
}

export class DiagnosticEntryMapper {
  static toDomain(row: DiagnosticEntryRelationalEntity): DiagnosticEntry {
    const state: DiagnosticEntryState = {
      id: row.id,
      kindergartenId: row.kindergartenId,
      childId: row.childId,
      templateId: row.templateId,
      specialistId: row.specialistId,
      assessmentDate: coerceAssessmentDate(row.assessmentDate as unknown),
      data: row.data,
      summary: row.summary,
      recommendations: row.recommendations,
      attachments: row.attachments ?? [],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    // `rehydrate` skips the future-date invariant — historical rows can
    // legitimately predate today's clock.
    return DiagnosticEntry.rehydrate(state);
  }

  static toRelational(
    entry: DiagnosticEntry,
  ): Partial<DiagnosticEntryRelationalEntity> {
    const s = entry.toState();
    return {
      id: s.id,
      kindergartenId: s.kindergartenId,
      childId: s.childId,
      templateId: s.templateId,
      specialistId: s.specialistId,
      assessmentDate: s.assessmentDate,
      data: s.data,
      summary: s.summary,
      recommendations: s.recommendations,
      attachments: s.attachments.length > 0 ? s.attachments : null,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    };
  }
}
