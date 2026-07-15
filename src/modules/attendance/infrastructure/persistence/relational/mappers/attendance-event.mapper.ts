import { AttendanceEvent } from '../../../../domain/entities/attendance-event.entity';
import { AttendanceEventTypeOrmEntity } from '../entities/attendance-event.typeorm.entity';

export class AttendanceEventMapper {
  static toDomain(row: AttendanceEventTypeOrmEntity): AttendanceEvent {
    return AttendanceEvent.hydrate({
      id: row.id,
      kindergartenId: row.kindergarten_id,
      childId: row.child_id,
      eventType: row.event_type,
      method: row.method,
      recordedBy: row.recorded_by,
      pickupUserId: row.pickup_user_id,
      pickupRequestId: row.pickup_request_id,
      notes: row.notes,
      recordedAt:
        row.recorded_at instanceof Date
          ? row.recorded_at
          : new Date(row.recorded_at),
      createdAt:
        row.created_at instanceof Date
          ? row.created_at
          : new Date(row.created_at),
      deletedAt: toDateOrNull(row.deleted_at),
    });
  }
}

function toDateOrNull(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}
