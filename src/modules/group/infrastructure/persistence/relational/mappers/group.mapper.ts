import { Group } from '../../../../domain/entities/group.entity';
import { GroupEntity } from '../entities/group.entity';

export class GroupMapper {
  static toDomain(entity: GroupEntity): Group {
    return Group.hydrate({
      id: entity.id,
      kindergartenId: entity.kindergarten_id,
      name: entity.name,
      capacity: entity.capacity,
      ageRangeMin: entity.age_range_min,
      ageRangeMax: entity.age_range_max,
      currentLocationId: entity.current_location_id,
      archivedAt: entity.archived_at,
      createdAt: entity.created_at,
      updatedAt: entity.updated_at,
    });
  }
}
