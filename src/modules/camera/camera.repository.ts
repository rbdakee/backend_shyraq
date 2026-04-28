import { Camera } from './domain/entities/camera.entity';

export interface CreateCameraInput {
  locationId: string;
  name: string;
  rtspUrl: string;
  hlsUrl?: string | null;
}

export interface UpdateCameraInput {
  locationId?: string;
  name?: string;
  rtspUrl?: string;
  hlsUrl?: string | null;
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

  abstract list(
    kindergartenId: string,
    filters?: ListCamerasFilters,
  ): Promise<Camera[]>;

  abstract update(
    kindergartenId: string,
    id: string,
    patch: UpdateCameraInput,
  ): Promise<Camera | null>;

  abstract save(camera: Camera): Promise<Camera>;
}
