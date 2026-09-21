import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { InvariantViolationError } from '@/shared-kernel/domain/errors';
import { CctvDisplayPolicyService } from './cctv-display-policy.service';
import { Camera, CameraState } from './domain/entities/camera.entity';
import { CctvDisplayPolicy } from './domain/entities/cctv-display-policy.entity';
import { CameraArchivedError } from './domain/errors/camera-archived.error';
import { CameraNotFoundError } from './domain/errors/camera-not-found.error';
import { CameraRepository } from './infrastructure/persistence/camera.repository';
import {
  CctvDisplayPolicyRepository,
  SaveCctvDisplayPolicyInput,
} from './infrastructure/persistence/cctv-display-policy.repository';

const KG = 'kg-1';
const NOW = new Date('2026-09-14T12:00:00.000Z');

class FixedClock extends ClockPort {
  now(): Date {
    return NOW;
  }
}

function camera(overrides: Partial<CameraState> = {}): Camera {
  return Camera.hydrate({
    id: 'cam-1',
    kindergartenId: KG,
    locationId: 'loc-1',
    name: 'Dala kiris',
    rtspUrl: 'rtsp://192.168.1.4:554/cam/realmonitor?channel=1&subtype=1',
    hlsUrl: null,
    streamKey: 'cam20_sub',
    streamKeyHd: null,
    videoCodec: 'h264',
    codecCheckedAt: NOW,
    isActive: true,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

function input(
  overrides: Partial<SaveCctvDisplayPolicyInput> = {},
): SaveCctvDisplayPolicyInput {
  return {
    workDays: [1, 2, 3, 4, 5],
    opensAt: '07:00',
    closesAt: '19:00',
    workHours: { mode: 'schedule', cameraIds: [] },
    offHours: { mode: 'off', cameraIds: [] },
    ...overrides,
  };
}

interface Fixture {
  service: CctvDisplayPolicyService;
  saved: SaveCctvDisplayPolicyInput | null;
  /** Ids the camera existence check asked about — null while it never ran. */
  askedCameraIds: string[] | null;
}

function build(
  opts: { stored?: CctvDisplayPolicy | null; cameras?: Camera[] } = {},
): Fixture {
  const state: Fixture = {
    service: undefined as unknown as CctvDisplayPolicyService,
    saved: null,
    askedCameraIds: null,
  };
  const rows = opts.cameras ?? [camera()];

  const policies = {
    findByKindergarten: () => Promise.resolve(opts.stored ?? null),
    upsert: (_kg: string, patch: SaveCctvDisplayPolicyInput) => {
      state.saved = patch;
      return Promise.resolve(
        CctvDisplayPolicy.hydrate({
          kindergartenId: KG,
          ...patch,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      );
    },
  } as unknown as CctvDisplayPolicyRepository;

  const cameras = {
    listByIds: (_kg: string, ids: string[]) => {
      state.askedCameraIds = ids;
      return Promise.resolve(
        ids
          .map((id) => rows.find((row) => row.id === id))
          .filter((row): row is Camera => row !== undefined),
      );
    },
  } as unknown as CameraRepository;

  state.service = new CctvDisplayPolicyService(
    policies,
    cameras,
    new FixedClock(),
  );
  return state;
}

describe('CctvDisplayPolicyService.get', () => {
  it('returns the defaults for a kindergarten that never saved a policy', async () => {
    const { service } = build();

    const policy = await service.get(KG);

    expect(policy.workHours).toEqual({ mode: 'schedule', cameraIds: [] });
    expect(policy.offHours).toEqual({ mode: 'schedule', cameraIds: [] });
    expect(policy.opensAt).toBe('07:00');
  });

  it('returns the stored policy once one exists', async () => {
    const stored = CctvDisplayPolicy.hydrate({
      kindergartenId: KG,
      workDays: [1, 2, 3, 4, 5, 6],
      opensAt: '08:00',
      closesAt: '18:00',
      workHours: { mode: 'cameras', cameraIds: ['cam-1'] },
      offHours: { mode: 'off', cameraIds: [] },
      createdAt: NOW,
      updatedAt: NOW,
    });
    const { service } = build({ stored });

    const policy = await service.get(KG);

    expect(policy.workHours).toEqual({ mode: 'cameras', cameraIds: ['cam-1'] });
    expect(policy.closesAt).toBe('18:00');
  });
});

describe('CctvDisplayPolicyService.save', () => {
  it('stores a policy whose cameras all exist in this kindergarten', async () => {
    const state = build();

    const policy = await state.service.save(
      KG,
      input({ offHours: { mode: 'cameras', cameraIds: ['cam-1'] } }),
    );

    expect(state.saved?.offHours).toEqual({
      mode: 'cameras',
      cameraIds: ['cam-1'],
    });
    expect(policy.offHours.cameraIds).toEqual(['cam-1']);
  });

  it('rejects a camera id that names nothing in this tenant', async () => {
    const state = build();

    await expect(
      state.service.save(
        KG,
        input({ workHours: { mode: 'cameras', cameraIds: ['cam-elsewhere'] } }),
      ),
    ).rejects.toBeInstanceOf(CameraNotFoundError);
    expect(state.saved).toBeNull();
  });

  it('rejects an archived camera while the admin is still on the screen', async () => {
    const state = build({
      cameras: [camera({ archivedAt: NOW, isActive: false })],
    });

    await expect(
      state.service.save(
        KG,
        input({ workHours: { mode: 'cameras', cameraIds: ['cam-1'] } }),
      ),
    ).rejects.toBeInstanceOf(CameraArchivedError);
  });

  it('rejects a window that closes before it opens', async () => {
    const state = build();

    await expect(
      state.service.save(KG, input({ opensAt: '19:00', closesAt: '07:00' })),
    ).rejects.toBeInstanceOf(InvariantViolationError);
    expect(state.saved).toBeNull();
  });

  it('normalises the days before storing them', async () => {
    const state = build();

    await state.service.save(KG, input({ workDays: [3, 1, 3] }));

    expect(state.saved?.workDays).toEqual([1, 3]);
  });

  it('checks each camera once even when both slots name it', async () => {
    const state = build();

    await state.service.save(
      KG,
      input({
        workHours: { mode: 'cameras', cameraIds: ['cam-1'] },
        offHours: { mode: 'cameras', cameraIds: ['cam-1'] },
      }),
    );

    expect(state.askedCameraIds).toEqual(['cam-1']);
  });

  it('touches no camera at all when neither slot names one', async () => {
    const state = build();

    await state.service.save(KG, input());

    expect(state.askedCameraIds).toBeNull();
  });
});
