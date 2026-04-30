/**
 * Sealed enum-VO mirroring `schedule_template_slots.day_of_week` (varchar(3)).
 * Used as the iso-week-day discriminator inside a weekly schedule template.
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
 * when projecting a slot onto a concrete date.
 */
export const ISO_WEEKDAY_TO_DAY: ReadonlyArray<DayOfWeekValue> = [
  // index 0 unused (iso days are 1..7)
  'sun',
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
  return ISO_WEEKDAY_TO_DAY[isoWeekday];
}

/** ISO weekday for a JS Date: getDay() returns 0..6 with 0=Sun; we want Mon=1..Sun=7. */
export function isoWeekdayOf(date: Date): number {
  const js = date.getUTCDay();
  return js === 0 ? 7 : js;
}

export function isDayOfWeek(value: string): value is DayOfWeekValue {
  return (DAY_OF_WEEK_VALUES as readonly string[]).includes(value);
}
