import { Camera } from '../../../../domain/entities/camera.entity';
import { CameraEntity } from '../entities/camera.entity';

export class CameraMapper {
  static toDomain(entity: CameraEntity): Camera {
    return Camera.hydrate({
      id: entity.id,
      kindergartenId: entity.kindergarten_id,
      locationId: entity.location_id,
      name: entity.name,
      rtspUrl: entity.rtsp_url,
      hlsUrl: entity.hls_url,
      isActive: entity.is_active,
      archivedAt: entity.archived_at,
      createdAt: entity.created_at,
      updatedAt: entity.updated_at,
    });
  }
}
