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
  const ymd = formatDateInTimezone(date, timeZone);
  return new Date(`${ymd}T00:00:00.000Z`);
}

/**
 * Returns `YYYY-MM-DD` for the calendar day of `date` rendered in `timeZone`.
 * Default Asia/Almaty (UTC+5, no DST). Use this everywhere that previously
 * called `date.toISOString().slice(0, 10)` against a wall-clock date — that
 * UTC-only formatter rolls over a day early for any kindergarten time after
 * 19:00 local. Mirrors the SQL `DATE(ts AT TIME ZONE 'Asia/Almaty')`
 * expression so JS/SQL stays consistent.
 *
 * Example: 2026-05-12T18:30:00Z → '2026-05-12' UTC, but '2026-05-12' Almaty;
 * 2026-05-12T19:30:00Z → '2026-05-12' UTC, but '2026-05-13' Almaty (00:30
 * next day).
 */
export function formatDateInTimezone(
  date: Date,
  timeZone: string = KG_DEFAULT_TIMEZONE,
): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * Returns today's `YYYY-MM-DD` in `timeZone`. Tiny convenience wrapper over
 * `formatDateInTimezone(new Date(), tz)` — exists so call sites read as
 * `todayInTimezone()` rather than the longer compose. Tests should inject a
 * `ClockPort.now()` and pass it to `formatDateInTimezone` directly to keep
 * determinism; this helper is for HTTP-edge code paths where wiring a Clock
 * would be overkill.
 */
export function todayInTimezone(
  timeZone: string = KG_DEFAULT_TIMEZONE,
): string {
  return formatDateInTimezone(new Date(), timeZone);
}

/**
 * Returns the midnight UTC instant for the first day of the month containing
 * `date` rendered in `timeZone`. Mirrors `startOfDayInTimezone` but anchored
 * to day=01. Used by billing flows (`buildPaymentCalendar`, `prepayInvoice`,
 * monthly cron) that derive `period_start` from `clock.now()`.
 *
 * Example: at 2026-05-31T22:00:00Z (which is 2026-06-01T03:00 in Asia/Almaty)
 * we want the June period — UTC midnight of 2026-06-01, NOT May.
 */
export function firstOfMonthInTimezone(
  date: Date,
  timeZone: string = KG_DEFAULT_TIMEZONE,
): Date {
  const ymd = formatDateInTimezone(date, timeZone);
  // en-CA → 'YYYY-MM-DD'. Slice off the day, force '01'.
  return new Date(`${ymd.slice(0, 7)}-01T00:00:00.000Z`);
}
