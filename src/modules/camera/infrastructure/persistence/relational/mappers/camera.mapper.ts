import { Camera } from '../../../../domain/entities/camera.entity';
import { isVideoCodec } from '../../../../domain/value-objects/video-codec.vo';
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
      streamKey: entity.stream_key,
      streamKeyHd: entity.stream_key_hd,
      // Rows predating the probe (and any hand-edited value the CHECK
      // constraint would have let through) fold to "never probed" rather
      // than becoming an unmodelled codec inside the domain.
      videoCodec: isVideoCodec(entity.video_codec) ? entity.video_codec : null,
      codecCheckedAt: entity.codec_checked_at,
      isActive: entity.is_active,
      archivedAt: entity.archived_at,
      createdAt: entity.created_at,
      updatedAt: entity.updated_at,
    });
  }
}
