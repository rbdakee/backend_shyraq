import { Inject, Injectable } from '@nestjs/common';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { LocationRepository } from '@/modules/location/location.repository';
import { LocationNotFoundError } from '@/modules/location/domain/errors/location-not-found.error';
import {
  CameraRepository,
  CreateCameraInput,
  ListCamerasFilters,
  UpdateCameraInput,
} from './camera.repository';
import { Camera } from './domain/entities/camera.entity';
import { CameraArchivedError } from './domain/errors/camera-archived.error';
import { CameraNotFoundError } from './domain/errors/camera-not-found.error';

const PLACEHOLDER_RTSP = 'rtsp://mediamtx:8554/cam-placeholder';

/**
 * CameraService — admin-scoped CRUD for CCTV cameras anchored to locations.
 * Cross-tenant location reuse is rejected: every link/relink call goes
 * through `LocationRepository.findById(kgId, ...)` so a stolen UUID from a
 * neighbouring tenant never resolves.
 */
@Injectable()
export class CameraService {
  constructor(
    private readonly cameras: CameraRepository,
    private readonly locations: LocationRepository,
    @Inject(ClockPort) private readonly clock: ClockPort,
  ) {}

  list(
    kindergartenId: string,
    filters?: ListCamerasFilters,
  ): Promise<Camera[]> {
    return this.cameras.list(kindergartenId, filters);
  }

  async getById(kindergartenId: string, id: string): Promise<Camera> {
    const row = await this.cameras.findById(kindergartenId, id);
    if (!row) throw new CameraNotFoundError(id);
    return row;
  }

  async create(
    kindergartenId: string,
    input: Omit<CreateCameraInput, 'rtspUrl'> & { rtspUrl?: string },
  ): Promise<Camera> {
    const location = await this.locations.findById(
      kindergartenId,
      input.locationId,
    );
    if (!location) throw new LocationNotFoundError(input.locationId);
    return this.cameras.create(kindergartenId, {
      locationId: input.locationId,
      name: input.name,
      rtspUrl: input.rtspUrl ?? PLACEHOLDER_RTSP,
      hlsUrl: input.hlsUrl ?? null,
    });
  }

  async update(
    kindergartenId: string,
    id: string,
    patch: UpdateCameraInput,
  ): Promise<Camera> {
    const current = await this.cameras.findById(kindergartenId, id);
    if (!current) throw new CameraNotFoundError(id);
    if (current.isArchived) throw new CameraArchivedError(id);
    if (patch.locationId !== undefined) {
      const location = await this.locations.findById(
        kindergartenId,
        patch.locationId,
      );
      if (!location) throw new LocationNotFoundError(patch.locationId);
    }
    const updated = await this.cameras.update(kindergartenId, id, patch);
    if (!updated) throw new CameraNotFoundError(id);
    return updated;
  }

  /**
   * Move a camera to a new location. Convenience wrapper over `update` —
   * also asserts location belongs to the same tenant before re-anchoring.
   */
  async linkToLocation(
    kindergartenId: string,
    id: string,
    locationId: string,
  ): Promise<Camera> {
    const current = await this.cameras.findById(kindergartenId, id);
    if (!current) throw new CameraNotFoundError(id);
    if (current.isArchived) throw new CameraArchivedError(id);
    const location = await this.locations.findById(kindergartenId, locationId);
    if (!location) throw new LocationNotFoundError(locationId);
    current.linkToLocation(locationId, this.clock.now());
    return this.cameras.save(current);
  }

  async archive(kindergartenId: string, id: string): Promise<Camera> {
    const current = await this.cameras.findById(kindergartenId, id);
    if (!current) throw new CameraNotFoundError(id);
    if (current.isArchived) return current;
    current.archive(this.clock.now());
    return this.cameras.save(current);
  }

  async restore(kindergartenId: string, id: string): Promise<Camera> {
    const current = await this.cameras.findById(kindergartenId, id);
    if (!current) throw new CameraNotFoundError(id);
    if (!current.isArchived) return current;
    current.restore(this.clock.now());
    return this.cameras.save(current);
  }
}
