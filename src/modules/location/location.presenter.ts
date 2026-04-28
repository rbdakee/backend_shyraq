import { Location } from './domain/entities/location.entity';
import { LocationDto } from './dto/location-response.dto';

export class LocationPresenter {
  static location(loc: Location): LocationDto {
    const s = loc.toState();
    return {
      id: s.id,
      kindergarten_id: s.kindergartenId,
      name: s.name,
      description: s.description,
      archived_at: s.archivedAt ? s.archivedAt.toISOString() : null,
      created_at: s.createdAt.toISOString(),
      updated_at: s.updatedAt.toISOString(),
    };
  }
}
