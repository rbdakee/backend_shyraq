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
import { CctvDisplayPolicyService } from './cctv-display-policy.service';
import { CctvStreamTokenService } from './cctv-stream-token.service';
import { Camera, CameraState } from './domain/entities/camera.entity';
import {
  CctvDisplayPolicy,
  CctvHideRule,
} from './domain/entities/cctv-display-policy.entity';
import { CctvAccessDeniedError } from './domain/errors/cctv-access-denied.error';
import { CameraRepository } from './infrastructure/persistence/camera.repository';
import { CctvDisplayPolicyRepository } from './infrastructure/persistence/cctv-display-policy.repository';
import { ParentCctvService } from './parent-cctv.service';

const KG = 'kg-1';
const CHILD = 'child-1';
const USER = 'user-1';
const GROUP = 'group-1';
const LOCATION = 'loc-1';
/** Where the common cameras hang — no group is assigned there. */
const CANTEEN_LOCATION = 'loc-2';
const CLUBS_LOCATION = 'loc-3';
/** Monday 17:00 Asia/Almaty. */
const NOW = new Date('2026-09-14T12:00:00.000Z');
/** Same Monday, 13:00 Asia/Almaty — inside a 12:30–15:00 lunch rule. */
const LUNCH = new Date('2026-09-14T08:00:00.000Z');
const PUBLIC_BASE = 'https://balam-stream.innodev.kz';

class FixedClock extends ClockPort {
  constructor(private readonly at: Date = NOW) {
    super();
  }
  now(): Date {
    return this.at;
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
  /** The location the camera lookup was actually made against. */
  askedLocationId: string | null;
  /** The ids a by-id lookup was made for — null while none happened. */
  askedCameraIds: string[] | null;
}

function build(
  opts: {
    cameras?: Camera[];
    currentGroupId?: string | null;
    currentLocationId?: string | null;
    publicBase?: string | null;
    secret?: string | null;
    /** Omitted = the kindergarten never saved a policy. */
    policy?: { commonCameraIds?: string[]; hideRules?: CctvHideRule[] };
    now?: Date;
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
    askedLocationId: null,
    askedCameraIds: null,
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
    list: (_kg: string, filter: { locationId?: string }) => {
      state.askedLocationId = filter.locationId ?? null;
      return Promise.resolve(
        state.cameras.filter((cam) => cam.locationId === filter.locationId),
      );
    },
    listByIds: (_kg: string, ids: string[]) => {
      state.askedCameraIds = ids;
      return Promise.resolve(
        ids
          .map((id) => state.cameras.find((cam) => cam.id === id))
          .filter((cam): cam is Camera => cam !== undefined),
      );
    },
  } as unknown as CameraRepository;

  const locations = {
    list: () =>
      Promise.resolve([
        { id: LOCATION, name: 'Столовая' },
        { id: CANTEEN_LOCATION, name: 'Асхана' },
        { id: CLUBS_LOCATION, name: 'Үйірмелер' },
      ] as unknown as Location[]),
  } as unknown as LocationRepository;

  const stored = opts.policy
    ? CctvDisplayPolicy.hydrate({
        kindergartenId: KG,
        commonCameraIds: opts.policy.commonCameraIds ?? [],
        hideRules: opts.policy.hideRules ?? [],
        createdAt: NOW,
        updatedAt: NOW,
      })
    : null;
  const policies = {
    findByKindergarten: () => Promise.resolve(stored),
  } as unknown as CctvDisplayPolicyRepository;

  const config = new ConfigService({
    cctv: {
      streamPublicBase:
        opts.publicBase === undefined ? PUBLIC_BASE : opts.publicBase,
      streamTokenSecret:
        opts.secret === undefined ? 'a'.repeat(40) : opts.secret,
      streamTokenTtlSeconds: 3600,
    },
  }) as ConfigService<AllConfigType>;

  const clock = new FixedClock(opts.now ?? NOW);
  state.service = new ParentCctvService(
    children,
    groups,
    cameras,
    locations,
    clock,
    new CctvStreamTokenService(config, clock),
    // The real policy service, not a fake: the decision this suite exercises
    // lives in the entity behind it, and stubbing it would test nothing.
    new CctvDisplayPolicyService(policies, cameras, clock),
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

describe('ParentCctvService display policy', () => {
  const canteen = (): Camera =>
    camera({
      id: 'cam-canteen',
      locationId: CANTEEN_LOCATION,
      name: 'Асхана',
      streamKey: 'cam05_sub',
    });
  const clubs = (): Camera =>
    camera({
      id: 'cam-clubs',
      locationId: CLUBS_LOCATION,
      name: 'Үйірмелер',
      streamKey: 'cam06_sub',
    });
  const lunchRule: CctvHideRule = {
    name: 'Обед',
    enabled: true,
    days: [1, 2, 3, 4, 5, 6, 7],
    from: '12:30',
    to: '15:00',
    allCameras: false,
    cameraIds: ['cam-canteen', 'cam-clubs'],
  };

  async function names(state: Fixture): Promise<string[]> {
    const view = await state.service.listForChild(
      KG,
      CHILD,
      USER,
      guardian('primary'),
    );
    return view.cameras.map((v) => v.camera.name);
  }

  it('shows the group camera first, then the common cameras in admin order', async () => {
    const state = build({
      cameras: [camera(), canteen(), clubs()],
      policy: { commonCameraIds: ['cam-clubs', 'cam-canteen'] },
    });

    expect(await names(state)).toEqual(['Ashana', 'Үйірмелер', 'Асхана']);
  });

  it('hides the common cameras a rule covers and keeps the group camera', async () => {
    const state = build({
      cameras: [camera(), canteen(), clubs()],
      policy: {
        commonCameraIds: ['cam-canteen', 'cam-clubs'],
        hideRules: [lunchRule],
      },
      now: LUNCH,
    });

    expect(await names(state)).toEqual(['Ashana']);
  });

  it('ignores a disabled rule', async () => {
    const state = build({
      cameras: [camera(), canteen()],
      policy: {
        commonCameraIds: ['cam-canteen'],
        hideRules: [
          { ...lunchRule, enabled: false, cameraIds: ['cam-canteen'] },
        ],
      },
      now: LUNCH,
    });

    expect(await names(state)).toEqual(['Ashana', 'Асхана']);
  });

  it('shows only common cameras to a child with no group', async () => {
    const state = build({
      cameras: [camera(), canteen()],
      currentGroupId: null,
      policy: { commonCameraIds: ['cam-canteen'] },
    });

    expect(await names(state)).toEqual(['Асхана']);
  });

  it('does not list a common camera twice when it is also the group camera', async () => {
    const state = build({
      cameras: [camera()],
      policy: { commonCameraIds: ['cam-1'] },
    });

    expect(await names(state)).toEqual(['Ashana']);
  });

  it('drops a common camera that is no longer bound to the gateway', async () => {
    const unbound = camera({
      id: 'cam-clubs',
      locationId: CLUBS_LOCATION,
      name: 'Үйірмелер',
      streamKey: null,
    });
    const state = build({
      cameras: [camera(), canteen(), unbound],
      policy: { commonCameraIds: ['cam-canteen', 'cam-clubs'] },
    });

    expect(await names(state)).toEqual(['Ashana', 'Асхана']);
  });

  it('shows only the group camera when no policy was ever saved', async () => {
    const state = build({ cameras: [camera(), canteen()] });

    expect(await names(state)).toEqual(['Ashana']);
  });
});
