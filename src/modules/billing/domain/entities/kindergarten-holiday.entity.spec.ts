import {
  KindergartenHoliday,
  KindergartenHolidayState,
} from './kindergarten-holiday.entity';

const NOW = new Date('2026-05-07T10:00:00Z');

function makeHoliday(
  overrides: Partial<KindergartenHolidayState> = {},
): KindergartenHolidayState {
  return {
    id: 'hol-uuid-0001',
    kindergartenId: 'kg-uuid-0001',
    date: new Date('2026-03-22'),
    name: { ru: 'Наурыз', kk: 'Наурыз мейрамы' },
    isBillable: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('KindergartenHoliday domain entity', () => {
  it('constructs successfully with at least one locale key', () => {
    expect(() => KindergartenHoliday.fromState(makeHoliday())).not.toThrow();
  });

  it('constructs successfully with a single-locale name map', () => {
    expect(() =>
      KindergartenHoliday.fromState(makeHoliday({ name: { ru: 'Праздник' } })),
    ).not.toThrow();
  });

  it('throws when name has no locale keys', () => {
    expect(() =>
      KindergartenHoliday.fromState(makeHoliday({ name: {} })),
    ).toThrow(/at least one locale key/);
  });

  it('exposes isBillable=false by default', () => {
    expect(KindergartenHoliday.fromState(makeHoliday()).isBillable).toBe(false);
  });

  it('preserves isBillable=true for paid-leave-style entries', () => {
    expect(
      KindergartenHoliday.fromState(makeHoliday({ isBillable: true }))
        .isBillable,
    ).toBe(true);
  });

  it('round-trips state through fromState and toState', () => {
    const state = makeHoliday();
    expect(KindergartenHoliday.fromState(state).toState()).toEqual(state);
  });
});
