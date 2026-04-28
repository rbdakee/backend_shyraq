import { Child } from '../../../../domain/entities/child.entity';
import { ChildEntity } from '../entities/child.entity';

/**
 * Convert between TypeORM rows and the domain Child aggregate. Mapping is
 * one-way (row → domain) here; persistence writes go through the repository
 * impl which knows how to translate `Child.toState()` back into column
 * values column-by-column.
 */
export class ChildMapper {
  static toDomain(entity: ChildEntity): Child {
    const dob =
      entity.date_of_birth instanceof Date
        ? entity.date_of_birth
        : new Date(entity.date_of_birth);
    const enrollmentDate =
      entity.enrollment_date === null
        ? null
        : entity.enrollment_date instanceof Date
          ? entity.enrollment_date
          : new Date(entity.enrollment_date);
    return Child.hydrate({
      id: entity.id,
      kindergartenId: entity.kindergarten_id,
      iin: entity.iin,
      fullName: entity.full_name,
      dateOfBirth: dob,
      gender:
        entity.gender === 'm' || entity.gender === 'f' ? entity.gender : null,
      photoUrl: entity.photo_url,
      status: entity.status,
      currentGroupId: entity.current_group_id,
      enrollmentDate,
      archivedAt: entity.archived_at,
      archiveReason: entity.archive_reason,
      medicalNotes: entity.medical_notes,
      allergyNotes: entity.allergy_notes,
      createdAt: entity.created_at,
      updatedAt: entity.updated_at,
    });
  }
}
