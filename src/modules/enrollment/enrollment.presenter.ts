import { Enrollment } from './domain/entities/enrollment.entity';
import { EnrollmentStatusLogEntry } from './domain/types/enrollment-status-log-entry';
import { EnrollmentResponseDto } from './dto/enrollment.response.dto';
import { EnrollmentStatusLogResponseDto } from './dto/enrollment-status-log.response.dto';

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export class EnrollmentPresenter {
  static toResponseDto(domain: Enrollment): EnrollmentResponseDto {
    const state = domain.toState();
    return {
      id: state.id,
      kindergartenId: state.kindergartenId,
      childId: state.childId,
      contactName: state.contactName,
      contactPhone: state.contactPhone,
      childName: state.childName,
      childDob: state.childDob === null ? null : toIsoDate(state.childDob),
      childIin: state.childIin,
      status: state.status,
      source: state.source,
      notes: state.notes,
      assignedTo: state.assignedTo,
      statusChangedAt: state.statusChangedAt.toISOString(),
      createdAt: state.createdAt.toISOString(),
      updatedAt: state.updatedAt.toISOString(),
    };
  }

  static toLogResponseDto(
    entry: EnrollmentStatusLogEntry,
  ): EnrollmentStatusLogResponseDto {
    return {
      id: entry.id,
      enrollmentId: entry.enrollmentId,
      kindergartenId: entry.kindergartenId,
      fromStatus: entry.fromStatus,
      toStatus: entry.toStatus,
      changedBy: entry.changedBy,
      comment: entry.comment,
      createdAt: entry.createdAt.toISOString(),
    };
  }
}
