import { Camera } from '../../domain/entities/camera.entity';

export interface CreateCameraInput {
  locationId: string;
  name: string;
  rtspUrl: string;
  hlsUrl?: string | null;
  streamKey?: string | null;
  streamKeyHd?: string | null;
}

export interface UpdateCameraInput {
  locationId?: string;
  name?: string;
  rtspUrl?: string;
  hlsUrl?: string | null;
  streamKey?: string | null;
  streamKeyHd?: string | null;
}

export interface ListCamerasFilters {
  locationId?: string;
  archived?: boolean;
}

export abstract class CameraRepository {
  abstract create(
    kindergartenId: string,
    input: CreateCameraInput,
  ): Promise<Camera>;

  abstract findById(kindergartenId: string, id: string): Promise<Camera | null>;

  /**
   * Look a camera up by id alone, without a tenant in scope.
   *
   * Used only by the streaming proxy, which authenticates with a signed
   * stream token rather than a session: the request arrives with no JWT and
   * therefore no tenant, but the camera id inside the token was minted by us
   * for a caller we had already authorised. Every other read path stays
   * tenant-scoped.
   */
  abstract findByIdCrossTenant(id: string): Promise<Camera | null>;

  abstract list(
    kindergartenId: string,
    filters?: ListCamerasFilters,
  ): Promise<Camera[]>;

  /**
   * Live cameras that carry a media-gateway stream key — the codec-probe
   * job's work list. Archived rows and rows without a key are skipped: there
   * is nothing on the gateway to ask about.
   */
  abstract listStreamable(kindergartenId: string): Promise<Camera[]>;

  abstract update(
    kindergartenId: string,
    id: string,
    patch: UpdateCameraInput,
  ): Promise<Camera | null>;

  abstract save(camera: Camera): Promise<Camera>;
}
