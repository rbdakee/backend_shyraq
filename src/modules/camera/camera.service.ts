import { Inject, Injectable } from '@nestjs/common';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { LocationRepository } from '@/modules/location/infrastructure/persistence/location.repository';
import { LocationNotFoundError } from '@/modules/location/domain/errors/location-not-found.error';
import {
  CameraRepository,
  CreateCameraInput,
  ListCamerasFilters,
  UpdateCameraInput,
} from './infrastructure/persistence/camera.repository';
import { Camera } from './domain/entities/camera.entity';
import { CameraArchivedError } from './domain/errors/camera-archived.error';
import { CameraNotFoundError } from './domain/errors/camera-not-found.error';
import { MediaGatewayPort } from './media-gateway.port';

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
    @Inject(MediaGatewayPort) private readonly gateway: MediaGatewayPort,
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
      streamKey: normalizeStreamKey(input.streamKey),
      streamKeyHd: normalizeStreamKey(input.streamKeyHd),
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
    const normalized: UpdateCameraInput = { ...patch };
    if (patch.streamKey !== undefined) {
      normalized.streamKey = normalizeStreamKey(patch.streamKey);
    }
    if (patch.streamKeyHd !== undefined) {
      normalized.streamKeyHd = normalizeStreamKey(patch.streamKeyHd);
    }
    const updated = await this.cameras.update(kindergartenId, id, normalized);
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

  /**
   * Ask the media gateway what this camera is actually emitting and store the
   * answer. This is the only write path for `video_codec` — the field is
   * observed, never declared, which is what lets a kindergarten switch a
   * camera from H.265 to H.264 without anyone touching the backend.
   *
   * A camera with no stream key, or one the gateway cannot reach right now,
   * is returned untouched: the last known codec survives a flapping uplink,
   * and the stale `codec_checked_at` is the signal that something is wrong.
   */
  async refreshCodec(kindergartenId: string, id: string): Promise<Camera> {
    const current = await this.cameras.findById(kindergartenId, id);
    if (!current) throw new CameraNotFoundError(id);
    const streamKey = current.streamKey;
    if (!streamKey) return current;

    const probe = await this.gateway.probe(streamKey);
    if (!probe.available) return current;

    current.recordCodecProbe(probe.videoCodec, this.clock.now());
    return this.cameras.save(current);
  }

  /**
   * Probe every streamable camera of one kindergarten. Sequential on purpose:
   * each probe opens a real RTSP session across that kindergarten's uplink,
   * and a fan-out of sixteen at once competes with the parents who are
   * actually watching.
   */
  async refreshCodecs(kindergartenId: string): Promise<CodecRefreshSummary> {
    const cameras = await this.cameras.listStreamable(kindergartenId);
    const summary: CodecRefreshSummary = {
      probed: 0,
      updated: 0,
      unavailable: 0,
    };
    for (const camera of cameras) {
      const streamKey = camera.streamKey;
      if (!streamKey) continue;
      summary.probed += 1;
      const probe = await this.gateway.probe(streamKey);
      if (!probe.available) {
        summary.unavailable += 1;
        continue;
      }
      if (
        camera.videoCodec === probe.videoCodec &&
        camera.codecCheckedAt !== null
      ) {
        // Same answer as last time — still refresh the timestamp so a
        // long-stable camera is distinguishable from an unreachable one.
        camera.recordCodecProbe(probe.videoCodec, this.clock.now());
        await this.cameras.save(camera);
        continue;
      }
      camera.recordCodecProbe(probe.videoCodec, this.clock.now());
      await this.cameras.save(camera);
      summary.updated += 1;
    }
    return summary;
  }
}

export interface CodecRefreshSummary {
  /** Cameras that carried a stream key and were asked about. */
  probed: number;
  /** Cameras whose codec changed (including first-ever probe). */
  updated: number;
  /** Cameras the gateway could not reach. Their stored codec is untouched. */
  unavailable: number;
}

/**
 * Stream keys come from a human typing a go2rtc config name into the admin
 * panel. Trim it, and treat blank as "no key" so an accidental space does not
 * become a row that claims to be streamable and resolves to nothing.
 */
function normalizeStreamKey(
  value: string | null | undefined,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
