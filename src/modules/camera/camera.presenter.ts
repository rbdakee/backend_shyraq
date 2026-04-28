import { Camera } from './domain/entities/camera.entity';
import { CameraDto } from './dto/camera-response.dto';

export class CameraPresenter {
  static camera(cam: Camera): CameraDto {
    const s = cam.toState();
    return {
      id: s.id,
      kindergarten_id: s.kindergartenId,
      location_id: s.locationId,
      name: s.name,
      rtsp_url: s.rtspUrl,
      hls_url: s.hlsUrl,
      is_active: s.isActive,
      archived_at: s.archivedAt ? s.archivedAt.toISOString() : null,
      created_at: s.createdAt.toISOString(),
      updated_at: s.updatedAt.toISOString(),
    };
  }
}
