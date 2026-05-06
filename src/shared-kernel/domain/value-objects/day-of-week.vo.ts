/**
 * Sealed enum-VO mirroring `schedule_template_slots.day_of_week` (varchar(3)).
 * Used as the iso-week-day discriminator inside a weekly schedule template,
 * and by the parent-request day_off validator (B12).
 *
 * Moved from `src/modules/schedule/domain/value-objects/day-of-week.vo.ts`
 * to shared-kernel because it is now consumed by 2+ modules (schedule + parent-request).
 */
export const DAY_OF_WEEK_VALUES = [
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
  'sun',
] as const;

export type DayOfWeekValue = (typeof DAY_OF_WEEK_VALUES)[number];

/**
 * Map iso-day numbers (1=Mon … 7=Sun) → enum value. Used by `copyWeekToNext`
 * when projecting a slot onto a concrete date. Indexed by `iso - 1` so the
 * array length matches the semantic count (7 days, no bogus index-0 slot).
 */
export const ISO_WEEKDAY_TO_DAY: ReadonlyArray<DayOfWeekValue> = [
  'mon',
  'tue',
  'wed',
  'thu',
  'fri',
  'sat',
  'sun',
];

export function dayOfWeekFromIsoWeekday(isoWeekday: number): DayOfWeekValue {
  if (!Number.isInteger(isoWeekday) || isoWeekday < 1 || isoWeekday > 7) {
    throw new Error(`isoWeekday out of range: ${isoWeekday}`);
  }
  return ISO_WEEKDAY_TO_DAY[isoWeekday - 1];
}

/** ISO weekday for a JS Date: getDay() returns 0..6 with 0=Sun; we want Mon=1..Sun=7. */
export function isoWeekdayOf(date: Date): number {
  const js = date.getUTCDay();
  return js === 0 ? 7 : js;
}

export function isDayOfWeek(value: string): value is DayOfWeekValue {
  return (DAY_OF_WEEK_VALUES as readonly string[]).includes(value);
}

/**
 * Returns true if `date` falls on a Saturday (iso=6) or Sunday (iso=7).
 * Used by the parent-request day_off validator to ensure submitted weekend_dates
 * are actually weekend days.
 */
export function isWeekendDay(date: Date): boolean {
  return isoWeekdayOf(date) >= 6;
}
