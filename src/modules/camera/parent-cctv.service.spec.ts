import { ConfigService } from '@nestjs/config';
import { AllConfigType } from '@/config/config.type';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { GuardianPermissions } from '@/shared-kernel/domain/value-objects/guardian-permissions.vo';
import { GuardianRelation } from '@/shared-kernel/domain/value-objects/guardian-relation.vo';
import { Child } from '@/modules/child/domain/entities/child.entity';
import { ChildGuardian } from '@/modules/child/domain/entities/child-guardian.entity';
import { ChildNotFoundError } from '@/modules/child/domain/errors/child-not-found.error';
import { ChildRepository } from '@/modules/child/infrastructure/persistence/child.repository';
import { Group } from '@/modules/group/domain/entities/group.entity';
import { GroupRepository } from '@/modules/group/infrastructure/persistence/group.repository';
import { Location } from '@/modules/location/domain/entities/location.entity';
import { LocationRepository } from '@/modules/location/infrastructure/persistence/location.repository';
import { CctvStreamTokenService } from './cctv-stream-token.service';
import { Camera, CameraState } from './domain/entities/camera.entity';
import { CctvAccessDeniedError } from './domain/errors/cctv-access-denied.error';
import { CameraRepository } from './infrastructure/persistence/camera.repository';
import { ParentCctvService } from './parent-cctv.service';

const KG = 'kg-1';
const CHILD = 'child-1';
const USER = 'user-1';
const GROUP = 'group-1';
const LOCATION = 'loc-1';
const NOW = new Date('2026-09-14T12:00:00.000Z');
const PUBLIC_BASE = 'https://balam-stream.innodev.kz';

class FixedClock extends ClockPort {
  now(): Date {
    return NOW;
  }
}

function camera(overrides: Partial<CameraState> = {}): Camera {
  return Camera.hydrate({
    id: 'cam-1',
    kindergartenId: KG,
    locationId: LOCATION,
    name: 'Ashana',
    rtspUrl: 'rtsp://192.168.1.4:554/cam/realmonitor?channel=1&subtype=1',
    hlsUrl: null,
    streamKey: 'cam04_sub',
    streamKeyHd: null,
    videoCodec: 'h265',
    codecCheckedAt: NOW,
    isActive: true,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

function guardian(
  role: 'primary' | 'secondary' | 'nanny',
  overrides: Record<string, boolean> = {},
): ChildGuardian {
  // Only the two fields the service reads — the full aggregate needs a child,
  // a status machine and an invite trail that have nothing to do with CCTV.
  return {
    role: GuardianRelation.fromString(role),
    permissions: GuardianPermissions.fromObject(overrides),
  } as unknown as ChildGuardian;
}

interface Fixture {
  service: ParentCctvService;
  cameras: Camera[];
  child: { currentGroupId: string | null } | null;
  group: { currentLocationId: string | null } | null;
}

function build(
  opts: {
    cameras?: Camera[];
    currentGroupId?: string | null;
    currentLocationId?: string | null;
    publicBase?: string | null;
    secret?: string | null;
  } = {},
): Fixture {
  const state: Fixture = {
    service: undefined as unknown as ParentCctvService,
    cameras: opts.cameras ?? [camera()],
    // `??` would swallow an explicit null here, which is exactly the case
    // these fixtures exist to exercise.
    child: {
      currentGroupId:
        opts.currentGroupId === undefined ? GROUP : opts.currentGroupId,
    },
    group: {
      currentLocationId:
        opts.currentLocationId === undefined
          ? LOCATION
          : opts.currentLocationId,
    },
  };

  const children = {
    findById: (_kg: string, id: string) =>
      Promise.resolve(
        state.child && id === CHILD ? (state.child as unknown as Child) : null,
      ),
  } as unknown as ChildRepository;

  const groups = {
    findById: () => Promise.resolve((state.group as unknown as Group) ?? null),
  } as unknown as GroupRepository;

  const cameras = {
    list: () => Promise.resolve(state.cameras),
  } as unknown as CameraRepository;

  const locations = {
    findById: () =>
      Promise.resolve({
        id: LOCATION,
        name: 'Столовая',
      } as unknown as Location),
  } as unknown as LocationRepository;

  const config = new ConfigService({
    cctv: {
      streamPublicBase:
        opts.publicBase === undefined ? PUBLIC_BASE : opts.publicBase,
      streamTokenSecret:
        opts.secret === undefined ? 'a'.repeat(40) : opts.secret,
      streamTokenTtlSeconds: 3600,
    },
  }) as ConfigService<AllConfigType>;

  state.service = new ParentCctvService(
    children,
    groups,
    cameras,
    locations,
    new CctvStreamTokenService(config, new FixedClock()),
    config,
  );
  return state;
}

describe('ParentCctvService permissions', () => {
  it('rejects a nanny, who does not hold view_cctv by default', async () => {
    const { service } = build();

    await expect(
      service.listForChild(KG, CHILD, USER, guardian('nanny')),
    ).rejects.toBeInstanceOf(CctvAccessDeniedError);
  });

  it('admits a nanny once a primary grants view_cctv explicitly', async () => {
    const { service } = build();

    const view = await service.listForChild(
      KG,
      CHILD,
      USER,
      guardian('nanny', { view_cctv: true }),
    );

    expect(view.cameras).toHaveLength(1);
  });

  it('rejects a secondary whose view_cctv was turned off', async () => {
    const { service } = build();

    await expect(
      service.listForChild(
        KG,
        CHILD,
        USER,
        guardian('secondary', { view_cctv: false }),
      ),
    ).rejects.toBeInstanceOf(CctvAccessDeniedError);
  });

  it('admits a primary by default', async () => {
    const { service } = build();

    const view = await service.listForChild(
      KG,
      CHILD,
      USER,
      guardian('primary'),
    );

    expect(view.cameras).toHaveLength(1);
  });
});

describe('ParentCctvService resolution', () => {
  it('returns the camera of the location the group is in right now', async () => {
    const { service } = build();

    const view = await service.listForChild(
      KG,
      CHILD,
      USER,
      guardian('primary'),
    );

    expect(view.cameras[0].camera.name).toBe('Ashana');
    expect(view.cameras[0].locationName).toBe('Столовая');
    expect(view.expiresAt).toEqual(new Date('2026-09-14T13:00:00.000Z'));
  });

  it('returns an HLS url carrying a token for an H.265 camera', async () => {
    const { service } = build();

    const view = await service.listForChild(
      KG,
      CHILD,
      USER,
      guardian('primary'),
    );
    const streams = view.cameras[0].streams;

    expect(streams).toHaveLength(1);
    expect(streams[0].transport).toBe('hls');
    expect(streams[0].url).toContain(`${PUBLIC_BASE}/hls/cam-1/index.m3u8?t=`);
  });

  it('serves HLS only for an H.264 camera until the WebRTC path is built', async () => {
    const { service } = build({ cameras: [camera({ videoCodec: 'h264' })] });

    const view = await service.listForChild(
      KG,
      CHILD,
      USER,
      guardian('primary'),
    );

    // The camera supports both; we advertise only what we can actually serve.
    expect(view.cameras[0].camera.availableTransports).toEqual([
      'webrtc',
      'hls',
    ]);
    expect(view.cameras[0].streams.map((s) => s.transport)).toEqual(['hls']);
  });

  it('returns nothing when the child is in no group', async () => {
    const { service } = build({ currentGroupId: null });

    const view = await service.listForChild(
      KG,
      CHILD,
      USER,
      guardian('primary'),
    );

    expect(view).toEqual({ cameras: [], expiresAt: null });
  });

  it('returns nothing when the group is not anchored to a location', async () => {
    const { service } = build({ currentLocationId: null });

    const view = await service.listForChild(
      KG,
      CHILD,
      USER,
      guardian('primary'),
    );

    expect(view.cameras).toEqual([]);
  });

  it('skips a camera that is not bound to the media gateway', async () => {
    const { service } = build({ cameras: [camera({ streamKey: null })] });

    const view = await service.listForChild(
      KG,
      CHILD,
      USER,
      guardian('primary'),
    );

    expect(view.cameras).toEqual([]);
  });

  it('throws when the child is not in this tenant', async () => {
    const { service } = build();

    await expect(
      service.listForChild(KG, 'other-child', USER, guardian('primary')),
    ).rejects.toBeInstanceOf(ChildNotFoundError);
  });
});

describe('ParentCctvService configuration', () => {
  it('reports unconfigured when no streaming host is set', () => {
    expect(build({ publicBase: null }).service.isConfigured).toBe(false);
  });

  it('reports unconfigured when no signing key is set', () => {
    expect(build({ secret: null }).service.isConfigured).toBe(false);
  });

  it('reports configured once both are present', () => {
    expect(build().service.isConfigured).toBe(true);
  });
});
