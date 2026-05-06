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

/**
 * Default timezone for date-only domain logic in B12 single-region MVP.
 * Per-kg timezone is stored in `kindergartens.settings.timezone` but is not
 * yet threaded through every call-site; until then date validators default
 * to Asia/Almaty (UTC+5, no DST) which is the fixed app region.
 */
export const KG_DEFAULT_TIMEZONE = 'Asia/Almaty';

export function dayOfWeekFromIsoWeekday(isoWeekday: number): DayOfWeekValue {
  if (!Number.isInteger(isoWeekday) || isoWeekday < 1 || isoWeekday > 7) {
    throw new Error(`isoWeekday out of range: ${isoWeekday}`);
  }
  return ISO_WEEKDAY_TO_DAY[isoWeekday - 1];
}

/**
 * ISO weekday for a JS Date in the given timezone (default: Asia/Almaty).
 * Returns Mon=1..Sun=7. Schedule templates that operate in UTC (cron stability)
 * pass `'UTC'` explicitly; B12 parent-request validators leave the default so
 * date-only "is this a weekend?" checks honour the kg timezone — otherwise a
 * Sat/Sun date in Asia/Almaty near local midnight could be misread as Fri/Mon
 * by `getUTCDay()`.
 *
 * Implementation: we extract the local YYYY-MM-DD via `Intl.DateTimeFormat`
 * and reconstruct a midnight-UTC Date — its `getUTCDay()` then reflects the
 * intended local weekday.
 */
export function isoWeekdayOf(
  date: Date,
  timeZone: string = KG_DEFAULT_TIMEZONE,
): number {
  const local = startOfDayInTimezone(date, timeZone);
  const js = local.getUTCDay();
  return js === 0 ? 7 : js;
}

export function isDayOfWeek(value: string): value is DayOfWeekValue {
  return (DAY_OF_WEEK_VALUES as readonly string[]).includes(value);
}

/**
 * Returns true if `date` falls on a Saturday (iso=6) or Sunday (iso=7) in
 * the given timezone (default Asia/Almaty).
 */
export function isWeekendDay(
  date: Date,
  timeZone: string = KG_DEFAULT_TIMEZONE,
): boolean {
  return isoWeekdayOf(date, timeZone) >= 6;
}

/**
 * Returns the midnight UTC instant whose YYYY-MM-DD matches `date` rendered
 * in `timeZone`. Useful for date-only comparisons ("not in past") that must
 * honour the kindergarten's local calendar instead of UTC. Default timezone
 * Asia/Almaty (UTC+5, no DST) — see `KG_DEFAULT_TIMEZONE`.
 *
 * Example: at 2026-05-06T20:00:00Z (which is 2026-05-07T01:00 in Asia/Almaty)
 * `startOfDayInTimezone(now, 'Asia/Almaty')` returns `2026-05-07T00:00:00Z`.
 */
export function startOfDayInTimezone(
  date: Date,
  timeZone: string = KG_DEFAULT_TIMEZONE,
): Date {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
  return new Date(`${ymd}T00:00:00.000Z`);
}
