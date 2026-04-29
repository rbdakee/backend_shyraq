import { Enrollment } from '../../../../domain/entities/enrollment.entity';
import { EnrollmentEntity } from '../entities/enrollment.entity';

/**
 * Convert TypeORM rows into the domain Enrollment aggregate. The reverse
 * direction (domain → row) lives column-by-column in the relational repo
 * since `repo.update(...)` and `repo.insert(...)` need column-typed payloads.
 *
 * `child_dob` is read as either a JS Date (`@Column({type:'date'})` may
 * return Date or ISO string depending on driver+TypeORM version), so we
 * normalize to Date here — same pattern as ChildMapper.
 */
export class EnrollmentMapper {
  static toDomain(entity: EnrollmentEntity): Enrollment {
    const childDob =
      entity.child_dob === null || entity.child_dob === undefined
        ? null
        : entity.child_dob instanceof Date
          ? entity.child_dob
          : new Date(entity.child_dob);
    return Enrollment.hydrate({
      id: entity.id,
      kindergartenId: entity.kindergarten_id,
      childId: entity.child_id,
      contactName: entity.contact_name,
      contactPhone: entity.contact_phone,
      childName: entity.child_name,
      childDob,
      childIin: entity.child_iin,
      status: entity.status,
      source: entity.source,
      notes: entity.notes,
      assignedTo: entity.assigned_to,
      statusChangedAt: entity.status_changed_at,
      createdAt: entity.created_at,
      updatedAt: entity.updated_at,
    });
  }
}
