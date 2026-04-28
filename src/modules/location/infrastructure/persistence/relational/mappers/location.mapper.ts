import { Location } from '../../../../domain/entities/location.entity';
import { LocationEntity } from '../entities/location.entity';

export class LocationMapper {
  static toDomain(entity: LocationEntity): Location {
    return Location.hydrate({
      id: entity.id,
      kindergartenId: entity.kindergarten_id,
      name: entity.name,
      description: entity.description,
      archivedAt: entity.archived_at,
      createdAt: entity.created_at,
      updatedAt: entity.updated_at,
    });
  }
}
