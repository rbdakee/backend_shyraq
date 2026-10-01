import { CctvAccessDto } from './dto/parent-cctv-response.dto';
import { CctvAccessView } from './parent-cctv.service';

export class ParentCctvPresenter {
  static access(view: CctvAccessView): CctvAccessDto {
    return {
      cameras: view.cameras.map((entry) => ({
        camera_id: entry.camera.id,
        name: entry.camera.name,
        location_id: entry.camera.locationId,
        location_name: entry.locationName,
        video_codec: entry.camera.videoCodec,
        streams: entry.streams.map((s) => ({
          transport: s.transport,
          url: s.url,
        })),
      })),
      expires_at: view.expiresAt ? view.expiresAt.toISOString() : null,
    };
  }
}
