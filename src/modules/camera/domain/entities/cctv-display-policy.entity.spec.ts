import { InvariantViolationError } from '@/shared-kernel/domain/errors';
import {
  CCTV_POLICY_TIME_INVALID,
  CCTV_POLICY_WINDOW_INVALID,
  CCTV_POLICY_WORK_DAY_INVALID,
  CctvDisplayPolicy,
} from './cctv-display-policy.entity';

const KG = 'kg-1';
const NOW = new Date('2026-09-14T12:00:00.000Z');

function policy(
  overrides: {
    workDays?: number[];
    opensAt?: string;
    closesAt?: string;
    workHoursCameraIds?: string[];
    offHoursCameraIds?: string[];
  } = {},
): CctvDisplayPolicy {
  return CctvDisplayPolicy.hydrate({
    kindergartenId: KG,
    workDays: overrides.workDays ?? [1, 2, 3, 4, 5],
    opensAt: overrides.opensAt ?? '07:00',
    closesAt: overrides.closesAt ?? '19:00',
    workHours: {
      mode: 'schedule',
      cameraIds: overrides.workHoursCameraIds ?? [],
    },
    offHours: { mode: 'cameras', cameraIds: overrides.offHoursCameraIds ?? [] },
    createdAt: NOW,
    updatedAt: NOW,
  });
}

describe('CctvDisplayPolicy defaults', () => {
  it('follows the schedule around the clock, which is the pre-policy behaviour', () => {
    const subject = CctvDisplayPolicy.default(KG, NOW);

    expect(subject.workHours).toEqual({ mode: 'schedule', cameraIds: [] });
    expect(subject.offHours).toEqual({ mode: 'schedule', cameraIds: [] });
  });
});

describe('CctvDisplayPolicy validation', () => {
  it('rejects a window that closes before it opens', () => {
    expect(() => policy({ opensAt: '19:00', closesAt: '07:00' })).toThrow(
      InvariantViolationError,
    );
  });

  it('names the window error with a stable slug the admin panel can translate', () => {
    // InvariantViolationError puts `code` straight in the HTTP body, so this
    // string is contract, not a log line.
    expect(() => policy({ opensAt: '19:00', closesAt: '07:00' })).toThrow(
      CCTV_POLICY_WINDOW_INVALID,
    );
    expect(() => policy({ opensAt: '7:00' })).toThrow(CCTV_POLICY_TIME_INVALID);
    expect(() => policy({ workDays: [9] })).toThrow(
      CCTV_POLICY_WORK_DAY_INVALID,
    );
  });

  it('rejects an empty window', () => {
    expect(() => policy({ opensAt: '08:00', closesAt: '08:00' })).toThrow(
      InvariantViolationError,
    );
  });

  it('accepts the HH:MM:SS shape PostgreSQL renders a time column as', () => {
    expect(policy({ opensAt: '07:00:00', closesAt: '19:00:00' }).opensAt).toBe(
      '07:00',
    );
  });

  it('rejects a weekday outside 1..7', () => {
    expect(() => policy({ workDays: [0] })).toThrow(InvariantViolationError);
  });

  it('sorts and deduplicates the working days', () => {
    expect(policy({ workDays: [5, 1, 5, 3] }).workDays).toEqual([1, 3, 5]);
  });

  it('deduplicates a camera list, keeping the admin`s order', () => {
    expect(
      policy({ workHoursCameraIds: ['cam-b', 'cam-a', 'cam-b'] }).workHours
        .cameraIds,
    ).toEqual(['cam-b', 'cam-a']);
  });

  it('reports every camera it references across both slots, once each', () => {
    expect(
      policy({
        workHoursCameraIds: ['cam-a', 'cam-b'],
        offHoursCameraIds: ['cam-b', 'cam-c'],
      }).referencedCameraIds,
    ).toEqual(['cam-a', 'cam-b', 'cam-c']);
  });
});

describe('CctvDisplayPolicy decideAt', () => {
  // Asia/Almaty is UTC+5 with no DST, so local = UTC + 5h throughout.
  it('picks the working-hours slot at midday on a working day', () => {
    // Monday 17:00 local.
    expect(policy().decideAt(NOW).phase).toBe('work_hours');
  });

  it('picks the off-hours slot after closing time', () => {
    // Monday 20:00 local.
    expect(policy().decideAt(new Date('2026-09-14T15:00:00.000Z')).phase).toBe(
      'off_hours',
    );
  });

  it('picks the off-hours slot before opening time', () => {
    // Monday 06:30 local.
    expect(policy().decideAt(new Date('2026-09-14T01:30:00.000Z')).phase).toBe(
      'off_hours',
    );
  });

  it('picks the off-hours slot all day on a non-working day', () => {
    // Saturday 11:00 local — a working hour, but not a working day.
    expect(policy().decideAt(new Date('2026-09-19T06:00:00.000Z')).phase).toBe(
      'off_hours',
    );
  });

  it('counts the opening minute as working hours', () => {
    // Monday 07:00 local exactly.
    expect(policy().decideAt(new Date('2026-09-14T02:00:00.000Z')).phase).toBe(
      'work_hours',
    );
  });

  it('counts the closing minute as off-hours', () => {
    // Monday 19:00 local exactly — the window is half-open, so viewing has
    // already switched over.
    expect(policy().decideAt(new Date('2026-09-14T14:00:00.000Z')).phase).toBe(
      'off_hours',
    );
  });

  it('reads the window in kindergarten-local time, not UTC', () => {
    // 2026-09-14T14:30Z is 19:30 in Almaty — closed. Read as a UTC wall clock
    // it would be 14:30, i.e. the middle of the working day.
    expect(policy().decideAt(new Date('2026-09-14T14:30:00.000Z')).phase).toBe(
      'off_hours',
    );
  });

  it('carries the slot`s mode and cameras with the decision', () => {
    const subject = policy({ offHoursCameraIds: ['cam-outdoor'] });

    expect(subject.decideAt(new Date('2026-09-14T15:00:00.000Z'))).toEqual({
      phase: 'off_hours',
      mode: 'cameras',
      cameraIds: ['cam-outdoor'],
    });
  });

  it('treats every day as off-hours when no day is a working day', () => {
    expect(policy({ workDays: [] }).decideAt(NOW).phase).toBe('off_hours');
  });
});
