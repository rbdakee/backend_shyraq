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
import { ActivityEvent } from '@/modules/schedule/domain/entities/activity-event.entity';
import { ActivityEventRepository } from '@/modules/schedule/infrastructure/persistence/activity-event.repository';
import { CctvDisplayPolicyService } from './cctv-display-policy.service';
import { CctvStreamTokenService } from './cctv-stream-token.service';
import { Camera, CameraState } from './domain/entities/camera.entity';
import {
  CctvDisplayPolicy,
  CctvDisplaySlot,
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
/** Where the schedule says the group is, as opposed to its hand-set location. */
const SCHEDULED_LOCATION = 'loc-2';
/** Where the entrance cameras hang — nothing routes a group there. */
const OUTDOOR_LOCATION = 'loc-3';
/** Monday 17:00 Asia/Almaty — inside the default 07:00–19:00 Mon–Fri window. */
const NOW = new Date('2026-09-14T12:00:00.000Z');
/** Same Monday, 20:00 Asia/Almaty — after closing. */
const EVENING = new Date('2026-09-14T15:00:00.000Z');
/** Saturday 11:00 Asia/Almaty — a working hour on a non-working day. */
const WEEKEND = new Date('2026-09-19T06:00:00.000Z');
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
  event: { locationId: string | null } | null;
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
    /** `undefined` = no event covers now; `null` = an event with no room. */
    eventLocationId?: string | null;
    /** Omitted = the kindergarten never saved a policy. */
    policy?: {
      workDays?: number[];
      opensAt?: string;
      closesAt?: string;
      workHours?: CctvDisplaySlot;
      offHours?: CctvDisplaySlot;
    };
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
    event:
      opts.eventLocationId === undefined
        ? null
        : { locationId: opts.eventLocationId },
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
      return Promise.resolve(state.cameras);
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

  const events = {
    findCurrentForGroup: () =>
      Promise.resolve((state.event as unknown as ActivityEvent) ?? null),
  } as unknown as ActivityEventRepository;

  const locations = {
    list: () =>
      Promise.resolve([
        { id: LOCATION, name: 'Столовая' },
        { id: SCHEDULED_LOCATION, name: 'Спортзал' },
        { id: OUTDOOR_LOCATION, name: 'Вход' },
      ] as unknown as Location[]),
  } as unknown as LocationRepository;

  const stored = opts.policy
    ? CctvDisplayPolicy.hydrate({
        kindergartenId: KG,
        workDays: opts.policy.workDays ?? [1, 2, 3, 4, 5],
        opensAt: opts.policy.opensAt ?? '07:00',
        closesAt: opts.policy.closesAt ?? '19:00',
        workHours: opts.policy.workHours ?? { mode: 'schedule', cameraIds: [] },
        offHours: opts.policy.offHours ?? { mode: 'schedule', cameraIds: [] },
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
    events,
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

    expect(view).toEqual({
      cameras: [],
      expiresAt: null,
      displayMode: 'schedule',
    });
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

describe('ParentCctvService follows the schedule', () => {
  it('returns the cameras of the room the current event points at', async () => {
    const state = build({ eventLocationId: SCHEDULED_LOCATION });

    await state.service.listForChild(KG, CHILD, USER, guardian('primary'));

    // The group is still anchored to LOCATION by hand; the schedule wins while
    // an event is running, which is what makes the list follow the day.
    expect(state.askedLocationId).toBe(SCHEDULED_LOCATION);
  });

  it('falls back to the hand-set group location when no event covers now', async () => {
    const state = build();

    await state.service.listForChild(KG, CHILD, USER, guardian('primary'));

    expect(state.askedLocationId).toBe(LOCATION);
  });

  it('falls back to the group when the covering event carries no room', async () => {
    // A lesson with no location says nothing about place. Honouring it would
    // blank the list out mid-day for no reason.
    const state = build({ eventLocationId: null });

    await state.service.listForChild(KG, CHILD, USER, guardian('primary'));

    expect(state.askedLocationId).toBe(LOCATION);
  });

  it('returns an empty list when neither the schedule nor the group has a room', async () => {
    const state = build({ currentLocationId: null });

    const view = await state.service.listForChild(
      KG,
      CHILD,
      USER,
      guardian('primary'),
    );

    expect(view.cameras).toEqual([]);
  });

  it('serves a scheduled room even when the group was never anchored', async () => {
    const state = build({
      currentLocationId: null,
      eventLocationId: SCHEDULED_LOCATION,
    });

    const view = await state.service.listForChild(
      KG,
      CHILD,
      USER,
      guardian('primary'),
    );

    expect(state.askedLocationId).toBe(SCHEDULED_LOCATION);
    expect(view.cameras).toHaveLength(1);
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
  /** An entrance camera nothing routes a group to — only a policy names it. */
  function outdoor(): Camera {
    return camera({
      id: 'cam-outdoor',
      locationId: OUTDOOR_LOCATION,
      name: 'Dala kiris',
      streamKey: 'cam20_sub',
    });
  }

  it('shows the pinned cameras to every parent, whatever the schedule says', async () => {
    const state = build({
      cameras: [outdoor()],
      policy: {
        workHours: { mode: 'cameras', cameraIds: ['cam-outdoor'] },
      },
    });

    const view = await state.service.listForChild(
      KG,
      CHILD,
      USER,
      guardian('primary'),
    );

    expect(view.displayMode).toBe('cameras');
    expect(view.cameras.map((c) => c.camera.name)).toEqual(['Dala kiris']);
    expect(view.cameras[0].locationName).toBe('Вход');
    // The group chain is never walked in this mode — that is the whole point
    // of it while the per-room cameras are not live yet.
    expect(state.askedLocationId).toBeNull();
  });

  it('shows nothing at all when the slot is off', async () => {
    const state = build({
      policy: { workHours: { mode: 'off', cameraIds: [] } },
    });

    const view = await state.service.listForChild(
      KG,
      CHILD,
      USER,
      guardian('primary'),
    );

    expect(view).toEqual({ cameras: [], expiresAt: null, displayMode: 'off' });
    expect(state.askedLocationId).toBeNull();
  });

  it('falls back to the policy cameras when the group leads nowhere', async () => {
    const state = build({
      cameras: [outdoor()],
      currentGroupId: null,
      policy: {
        workHours: { mode: 'schedule', cameraIds: ['cam-outdoor'] },
      },
    });

    const view = await state.service.listForChild(
      KG,
      CHILD,
      USER,
      guardian('primary'),
    );

    expect(view.displayMode).toBe('schedule');
    expect(view.cameras.map((c) => c.camera.id)).toEqual(['cam-outdoor']);
  });

  it('prefers the room the group is in over the fallback list', async () => {
    const state = build({
      policy: {
        workHours: { mode: 'schedule', cameraIds: ['cam-outdoor'] },
      },
    });

    const view = await state.service.listForChild(
      KG,
      CHILD,
      USER,
      guardian('primary'),
    );

    expect(view.cameras.map((c) => c.camera.id)).toEqual(['cam-1']);
    expect(state.askedCameraIds).toBeNull();
  });

  it('drops a fallback camera that is no longer bound to the gateway', async () => {
    const state = build({
      cameras: [camera({ id: 'cam-outdoor', streamKey: null })],
      currentGroupId: null,
      policy: {
        workHours: { mode: 'schedule', cameraIds: ['cam-outdoor'] },
      },
    });

    const view = await state.service.listForChild(
      KG,
      CHILD,
      USER,
      guardian('primary'),
    );

    expect(view.cameras).toEqual([]);
  });

  it('switches to the off-hours slot after closing time', async () => {
    const state = build({
      cameras: [outdoor()],
      now: EVENING,
      policy: {
        workHours: { mode: 'schedule', cameraIds: [] },
        offHours: { mode: 'cameras', cameraIds: ['cam-outdoor'] },
      },
    });

    const view = await state.service.listForChild(
      KG,
      CHILD,
      USER,
      guardian('primary'),
    );

    expect(view.displayMode).toBe('cameras');
    expect(view.cameras.map((c) => c.camera.id)).toEqual(['cam-outdoor']);
  });

  it('treats a non-working day as off-hours even at midday', async () => {
    const state = build({
      now: WEEKEND,
      policy: { offHours: { mode: 'off', cameraIds: [] } },
    });

    const view = await state.service.listForChild(
      KG,
      CHILD,
      USER,
      guardian('primary'),
    );

    expect(view.displayMode).toBe('off');
    expect(view.cameras).toEqual([]);
  });

  it('keeps the schedule-driven list when no policy was ever saved', async () => {
    const state = build();

    const view = await state.service.listForChild(
      KG,
      CHILD,
      USER,
      guardian('primary'),
    );

    expect(view.displayMode).toBe('schedule');
    expect(view.cameras).toHaveLength(1);
    expect(state.askedLocationId).toBe(LOCATION);
  });
});
