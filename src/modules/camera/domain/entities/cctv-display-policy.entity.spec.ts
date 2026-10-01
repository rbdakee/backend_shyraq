import { InvariantViolationError } from '@/shared-kernel/domain/errors';
import {
  CCTV_POLICY_RULE_CAMERA_NOT_COMMON,
  CCTV_POLICY_TIME_INVALID,
  CCTV_POLICY_WINDOW_INVALID,
  CCTV_POLICY_WORK_DAY_INVALID,
  CctvDisplayPolicy,
  CctvHideRule,
} from './cctv-display-policy.entity';

const KG = 'kg-1';
const NOW = new Date('2026-09-14T12:00:00.000Z');
const COMMON = ['cam-canteen', 'cam-clubs'];

/** Asia/Almaty is UTC+5: local `HH:MM` on a given ISO date → UTC instant. */
function almaty(date: string, time: string): Date {
  return new Date(`${date}T${time}:00+05:00`);
}
// 2026-09-14 is a Monday, 2026-09-18 a Friday, 2026-09-19 a Saturday.

function rule(overrides: Partial<CctvHideRule> = {}): CctvHideRule {
  return {
    name: 'Обед',
    enabled: true,
    days: [1, 2, 3, 4, 5, 6, 7],
    from: '12:30',
    to: '15:00',
    allCameras: false,
    cameraIds: [...COMMON],
    ...overrides,
  };
}

function policy(hideRules: CctvHideRule[]): CctvDisplayPolicy {
  return CctvDisplayPolicy.hydrate({
    kindergartenId: KG,
    commonCameraIds: COMMON,
    hideRules,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(InvariantViolationError);
    expect((err as InvariantViolationError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe('CctvDisplayPolicy defaults', () => {
  it('has no common cameras and a disabled night rule', () => {
    const subject = CctvDisplayPolicy.default(KG, NOW);

    expect(subject.commonCameraIds).toEqual([]);
    expect(subject.hideRules).toEqual([
      {
        name: 'Ночь',
        enabled: false,
        days: [1, 2, 3, 4, 5, 6, 7],
        from: '19:00',
        to: '08:00',
        allCameras: true,
        cameraIds: [],
      },
    ]);
  });
});

describe('CctvDisplayPolicy.visibleCommonCameraIds', () => {
  it('shows every common camera outside any rule', () => {
    expect(
      policy([rule()]).visibleCommonCameraIds(almaty('2026-09-14', '11:00')),
    ).toEqual(COMMON);
  });

  it('hides the rule cameras inside the window, start inclusive', () => {
    const subject = policy([rule({ cameraIds: ['cam-canteen'] })]);

    expect(
      subject.visibleCommonCameraIds(almaty('2026-09-14', '12:30')),
    ).toEqual(['cam-clubs']);
  });

  it('shows them again at the end of the window, end exclusive', () => {
    expect(
      policy([rule()]).visibleCommonCameraIds(almaty('2026-09-14', '15:00')),
    ).toEqual(COMMON);
  });

  it('reads the window in kindergarten time, not UTC', () => {
    // 13:00 Almaty is 08:00Z — a UTC comparison would miss the lunch window.
    expect(
      policy([rule()]).visibleCommonCameraIds(new Date('2026-09-14T08:00:00Z')),
    ).toEqual([]);
  });

  it('applies only on the chosen weekdays', () => {
    const weekdays = policy([rule({ days: [1, 2, 3, 4, 5] })]);

    expect(
      weekdays.visibleCommonCameraIds(almaty('2026-09-19', '13:00')),
    ).toEqual(COMMON);
  });

  it('ignores a disabled rule', () => {
    expect(
      policy([rule({ enabled: false })]).visibleCommonCameraIds(
        almaty('2026-09-14', '13:00'),
      ),
    ).toEqual(COMMON);
  });

  it('hides every common camera for an all-cameras rule', () => {
    expect(
      policy([rule({ allCameras: true })]).visibleCommonCameraIds(
        almaty('2026-09-14', '13:00'),
      ),
    ).toEqual([]);
  });

  it('unions overlapping rules', () => {
    const subject = policy([
      rule({ cameraIds: ['cam-canteen'] }),
      rule({ from: '13:00', to: '14:00', cameraIds: ['cam-clubs'] }),
    ]);

    expect(
      subject.visibleCommonCameraIds(almaty('2026-09-14', '13:30')),
    ).toEqual([]);
  });

  describe('a window past midnight (19:00–08:00)', () => {
    const night = (days: number[]) =>
      policy([rule({ from: '19:00', to: '08:00', allCameras: true, days })]);

    it('covers the evening of a chosen day', () => {
      expect(
        night([5]).visibleCommonCameraIds(almaty('2026-09-18', '22:00')),
      ).toEqual([]);
    });

    it('covers the next morning, which belongs to the day the window started', () => {
      expect(
        night([5]).visibleCommonCameraIds(almaty('2026-09-19', '07:59')),
      ).toEqual([]);
    });

    it('does not cover the morning after a day it was not set for', () => {
      expect(
        night([5]).visibleCommonCameraIds(almaty('2026-09-18', '07:00')),
      ).toEqual(COMMON);
    });

    it('wraps Sunday night into Monday morning', () => {
      expect(
        night([7]).visibleCommonCameraIds(almaty('2026-09-14', '06:00')),
      ).toEqual([]);
    });

    it('leaves the daytime alone', () => {
      expect(
        night([1, 2, 3, 4, 5, 6, 7]).visibleCommonCameraIds(
          almaty('2026-09-14', '12:00'),
        ),
      ).toEqual(COMMON);
    });
  });
});

describe('CctvDisplayPolicy validation', () => {
  it('refuses a window that starts and ends at the same time', () => {
    expectCode(
      () => policy([rule({ from: '12:00', to: '12:00' })]),
      CCTV_POLICY_WINDOW_INVALID,
    );
  });

  it('refuses a malformed wall clock', () => {
    expectCode(
      () => policy([rule({ from: '25:00' })]),
      CCTV_POLICY_TIME_INVALID,
    );
  });

  it('refuses a weekday outside 1..7', () => {
    expectCode(
      () => policy([rule({ days: [0] })]),
      CCTV_POLICY_WORK_DAY_INVALID,
    );
  });

  it('refuses a rule hiding a camera that is not common', () => {
    expectCode(
      () => policy([rule({ cameraIds: ['cam-elsewhere'] })]),
      CCTV_POLICY_RULE_CAMERA_NOT_COMMON,
    );
  });

  it('drops camera ids from an all-cameras rule', () => {
    expect(policy([rule({ allCameras: true })]).hideRules[0].cameraIds).toEqual(
      [],
    );
  });

  it('accepts PG time with seconds and trims the name', () => {
    const [stored] = policy([
      rule({ name: '  Обед ', from: '12:30:00', to: '15:00:00' }),
    ]).hideRules;

    expect(stored).toMatchObject({ name: 'Обед', from: '12:30', to: '15:00' });
  });

  it('keeps the first position of a duplicated common camera', () => {
    const subject = CctvDisplayPolicy.hydrate({
      kindergartenId: KG,
      commonCameraIds: ['b', 'a', 'b'],
      hideRules: [],
      createdAt: NOW,
      updatedAt: NOW,
    });

    expect(subject.commonCameraIds).toEqual(['b', 'a']);
  });
});
