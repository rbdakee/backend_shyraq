import { ActivityEvent } from '../../../../domain/entities/activity-event.entity';
import { ActivityEventEntity } from '../entities/activity-event.entity';

export class ActivityEventMapper {
  static toDomain(row: ActivityEventEntity): ActivityEvent {
    return ActivityEvent.hydrate({
      id: row.id,
      kindergartenId: row.kindergarten_id,
      groupId: row.group_id,
      templateSlotId: row.template_slot_id,
      origin: row.origin,
      activityName: row.activity_name,
      category: row.category,
      locationId: row.location_id,
      startsAt:
        row.starts_at instanceof Date ? row.starts_at : new Date(row.starts_at),
      endsAt:
        row.ends_at === null
          ? null
          : row.ends_at instanceof Date
            ? row.ends_at
            : new Date(row.ends_at),
      status: row.status,
      createdBy: row.created_by,
      notes: row.notes,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }
}
