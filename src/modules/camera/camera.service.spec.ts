import { ConfigService } from '@nestjs/config';
import { AllConfigType } from '@/config/config.type';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { Location } from '@/modules/location/domain/entities/location.entity';
import { LocationRepository } from '@/modules/location/infrastructure/persistence/location.repository';
import { CameraService } from './camera.service';
import { CctvStreamTokenService } from './cctv-stream-token.service';
import { Camera, CameraState } from './domain/entities/camera.entity';
import { CameraNotFoundError } from './domain/errors/camera-not-found.error';
import { VideoCodec } from './domain/value-objects/video-codec.vo';
import {
  CameraRepository,
  CreateCameraInput,
  ListCamerasFilters,
  UpdateCameraInput,
} from './infrastructure/persistence/camera.repository';
import { MediaGatewayPort, StreamProbeResult } from './media-gateway.port';

const KG = 'kg-1';
const NOW = new Date('2026-09-14T12:00:00.000Z');

class FixedClock extends ClockPort {
  now(): Date {
    return NOW;
  }
}

class FakeLocationRepo extends LocationRepository {
  known = new Set<string>(['loc-1', 'loc-2']);

  findById(_kg: string, id: string): Promise<Location | null> {
    return Promise.resolve(
      this.known.has(id) ? ({ id } as unknown as Location) : null,
    );
  }
  create(): Promise<Location> {
    throw new Error('not used');
  }
  list(): Promise<Location[]> {
    throw new Error('not used');
  }
  update(): Promise<Location | null> {
    throw new Error('not used');
  }
  save(): Promise<Location> {
    throw new Error('not used');
  }
}

class FakeCameraRepo extends CameraRepository {
  rows: Camera[] = [];
  private seq = 0;

  seed(overrides: Partial<CameraState> = {}): Camera {
    const cam = Camera.hydrate({
      id: `cam-${++this.seq}`,
      kindergartenId: KG,
      locationId: 'loc-1',
      name: 'Ashana',
      rtspUrl: 'rtsp://192.168.1.4:554/cam/realmonitor?channel=1&subtype=1',
      hlsUrl: null,
      streamKey: 'cam04_sub',
      streamKeyHd: null,
      videoCodec: null,
      codecCheckedAt: null,
      isActive: true,
      archivedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    });
    this.rows.push(cam);
    return cam;
  }

  create(kg: string, input: CreateCameraInput): Promise<Camera> {
    return Promise.resolve(
      this.seed({
        kindergartenId: kg,
        locationId: input.locationId,
        name: input.name,
        rtspUrl: input.rtspUrl,
        hlsUrl: input.hlsUrl ?? null,
        streamKey: input.streamKey ?? null,
        streamKeyHd: input.streamKeyHd ?? null,
      }),
    );
  }

  findById(kg: string, id: string): Promise<Camera | null> {
    return Promise.resolve(
      this.rows.find((r) => r.kindergartenId === kg && r.id === id) ?? null,
    );
  }

  findByIdCrossTenant(id: string): Promise<Camera | null> {
    return Promise.resolve(this.rows.find((r) => r.id === id) ?? null);
  }

  list(kg: string, filters?: ListCamerasFilters): Promise<Camera[]> {
    return Promise.resolve(
      this.rows.filter(
        (r) =>
          r.kindergartenId === kg &&
          (filters?.locationId === undefined ||
            r.locationId === filters.locationId),
      ),
    );
  }

  listStreamable(kg: string): Promise<Camera[]> {
    return Promise.resolve(
      this.rows.filter(
        (r) => r.kindergartenId === kg && r.streamKey !== null && !r.isArchived,
      ),
    );
  }

  update(
    kg: string,
    id: string,
    patch: UpdateCameraInput,
  ): Promise<Camera | null> {
    const current = this.rows.find(
      (r) => r.kindergartenId === kg && r.id === id,
    );
    if (!current) return Promise.resolve(null);
    if (patch.name !== undefined) current.rename(patch.name, NOW);
    if (patch.rtspUrl !== undefined) current.setRtspUrl(patch.rtspUrl, NOW);
    if (patch.hlsUrl !== undefined) current.setHlsUrl(patch.hlsUrl, NOW);
    // Mirrors the SQL path, which also resets the probed codec on re-key.
    if (patch.streamKey !== undefined || patch.streamKeyHd !== undefined) {
      current.setStreamKeys(
        { streamKey: patch.streamKey, streamKeyHd: patch.streamKeyHd },
        NOW,
      );
    }
    return Promise.resolve(current);
  }

  save(camera: Camera): Promise<Camera> {
    this.rows = this.rows.map((r) => (r.id === camera.id ? camera : r));
    return Promise.resolve(camera);
  }
}

class FakeGateway extends MediaGatewayPort {
  results = new Map<string, StreamProbeResult>();
  probedKeys: string[] = [];

  setCodec(streamKey: string, videoCodec: VideoCodec): void {
    this.results.set(streamKey, { available: true, videoCodec });
  }
  setUnreachable(streamKey: string): void {
    this.results.set(streamKey, { available: false, videoCodec: 'unknown' });
  }

  probe(streamKey: string): Promise<StreamProbeResult> {
    this.probedKeys.push(streamKey);
    return Promise.resolve(
      this.results.get(streamKey) ?? {
        available: false,
        videoCodec: 'unknown',
      },
    );
  }
  listStreamKeys(): Promise<string[]> {
    return Promise.resolve([...this.results.keys()]);
  }
  playlistUrl(streamKey: string): string {
    return `http://gateway/api/stream.m3u8?src=${streamKey}&mp4`;
  }
  masterPlaylist(): Promise<string | null> {
    return Promise.resolve(null);
  }
  mediaPlaylist(): Promise<string | null> {
    return Promise.resolve(null);
  }
}

function build() {
  const cameras = new FakeCameraRepo();
  const locations = new FakeLocationRepo();
  const gateway = new FakeGateway();
  const clock = new FixedClock();
  const config = new ConfigService({
    cctv: {
      streamPublicBase: 'https://balam-stream.innodev.kz',
      streamTokenSecret: 'a'.repeat(40),
      streamTokenTtlSeconds: 3600,
    },
  }) as ConfigService<AllConfigType>;
  const service = new CameraService(
    cameras,
    locations,
    clock,
    gateway,
    new CctvStreamTokenService(config, clock),
    config,
  );
  return { service, cameras, locations, gateway };
}

describe('CameraService stream keys', () => {
  it('trims a stream key before storing it', async () => {
    const { service } = build();
    const cam = await service.create(KG, {
      locationId: 'loc-1',
      name: 'Reception',
      streamKey: '  cam05_sub  ',
    });
    expect(cam.streamKey).toBe('cam05_sub');
    expect(cam.isStreamable).toBe(true);
  });

  it('stores a blank stream key as no key at all', async () => {
    const { service } = build();
    const cam = await service.create(KG, {
      locationId: 'loc-1',
      name: 'Reception',
      streamKey: '   ',
    });
    expect(cam.streamKey).toBeNull();
    expect(cam.isStreamable).toBe(false);
    expect(cam.availableTransports).toEqual([]);
  });
});

describe('CameraService.refreshCodec', () => {
  it('stores the codec the gateway reports', async () => {
    const { service, cameras, gateway } = build();
    const seeded = cameras.seed({ streamKey: 'cam04_sub' });
    gateway.setCodec('cam04_sub', 'h265');

    const cam = await service.refreshCodec(KG, seeded.id);

    expect(cam.videoCodec).toBe('h265');
    expect(cam.codecCheckedAt).toEqual(NOW);
    expect(cam.availableTransports).toEqual(['hls']);
  });

  it('offers WebRTC as soon as a camera is switched to H.264', async () => {
    const { service, cameras, gateway } = build();
    const seeded = cameras.seed({
      streamKey: 'cam04_sub',
      videoCodec: 'h265',
      codecCheckedAt: NOW,
    });
    gateway.setCodec('cam04_sub', 'h264');

    const cam = await service.refreshCodec(KG, seeded.id);

    expect(cam.videoCodec).toBe('h264');
    expect(cam.availableTransports).toEqual(['webrtc', 'hls']);
  });

  it('keeps the last known codec when the gateway cannot reach the camera', async () => {
    const { service, cameras, gateway } = build();
    const checkedAt = new Date('2026-09-13T09:00:00.000Z');
    const seeded = cameras.seed({
      streamKey: 'cam04_sub',
      videoCodec: 'h264',
      codecCheckedAt: checkedAt,
    });
    gateway.setUnreachable('cam04_sub');

    const cam = await service.refreshCodec(KG, seeded.id);

    expect(cam.videoCodec).toBe('h264');
    expect(cam.codecCheckedAt).toEqual(checkedAt);
  });

  it('returns a keyless camera untouched without calling the gateway', async () => {
    const { service, cameras, gateway } = build();
    const seeded = cameras.seed({ streamKey: null });

    const cam = await service.refreshCodec(KG, seeded.id);

    expect(cam.videoCodec).toBeNull();
    expect(gateway.probedKeys).toEqual([]);
  });

  it('throws when the camera belongs to another tenant', async () => {
    const { service, cameras } = build();
    const seeded = cameras.seed({ kindergartenId: 'kg-2' });

    await expect(service.refreshCodec(KG, seeded.id)).rejects.toBeInstanceOf(
      CameraNotFoundError,
    );
  });
});

describe('CameraService.refreshCodecs', () => {
  it('probes every streamable camera and counts what changed', async () => {
    const { service, cameras, gateway } = build();
    cameras.seed({ streamKey: 'cam02_sub' });
    cameras.seed({ streamKey: 'cam03_sub' });
    cameras.seed({ streamKey: null });
    gateway.setCodec('cam02_sub', 'h265');
    gateway.setCodec('cam03_sub', 'h264');

    const summary = await service.refreshCodecs(KG);

    expect(summary).toEqual({ probed: 2, updated: 2, unavailable: 0 });
    expect(gateway.probedKeys).toEqual(['cam02_sub', 'cam03_sub']);
  });

  it('counts an unreachable camera separately and leaves its codec alone', async () => {
    const { service, cameras, gateway } = build();
    const stable = cameras.seed({
      streamKey: 'cam02_sub',
      videoCodec: 'h265',
      codecCheckedAt: NOW,
    });
    cameras.seed({ streamKey: 'cam16_sub' });
    gateway.setCodec('cam02_sub', 'h265');
    gateway.setUnreachable('cam16_sub');

    const summary = await service.refreshCodecs(KG);

    expect(summary).toEqual({ probed: 2, updated: 0, unavailable: 1 });
    expect(stable.videoCodec).toBe('h265');
  });

  it('skips archived cameras', async () => {
    const { service, cameras, gateway } = build();
    const archived = cameras.seed({ streamKey: 'cam02_sub' });
    archived.archive(NOW);
    gateway.setCodec('cam02_sub', 'h265');

    const summary = await service.refreshCodecs(KG);

    expect(summary.probed).toBe(0);
    expect(gateway.probedKeys).toEqual([]);
  });
});

describe('CameraService.streamAccess', () => {
  it('returns an HLS url for a streamable camera', async () => {
    const { service, cameras } = build();
    const seeded = cameras.seed({ streamKey: 'cam04_sub', videoCodec: 'h265' });

    const access = await service.streamAccess(KG, seeded.id, 'admin-1');

    expect(access.streams).toHaveLength(1);
    expect(access.streams[0].url).toContain(
      `https://balam-stream.innodev.kz/hls/${seeded.id}/index.m3u8?t=`,
    );
    expect(access.expiresAt).toEqual(new Date('2026-09-14T13:00:00.000Z'));
  });

  it('returns no urls for a camera that is not bound to the gateway', async () => {
    const { service, cameras } = build();
    const seeded = cameras.seed({ streamKey: null });

    const access = await service.streamAccess(KG, seeded.id, 'admin-1');

    expect(access.streams).toEqual([]);
    expect(access.expiresAt).toBeNull();
  });

  it('throws for a camera in another tenant', async () => {
    const { service, cameras } = build();
    const seeded = cameras.seed({ kindergartenId: 'kg-2' });

    await expect(
      service.streamAccess(KG, seeded.id, 'admin-1'),
    ).rejects.toBeInstanceOf(CameraNotFoundError);
  });
});
