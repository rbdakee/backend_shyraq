import { InvariantViolationError } from '../errors/invariant-violation.error';

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

/**
 * `HH:MM` or `HH:MM:SS`, both zero-padded. Matches the two shapes a naive
 * wall-clock time reaches us in: PG renders a `time` column as `'08:00:00'`,
 * admin UIs post the shorter `'08:00'`.
 */
const WALL_CLOCK_TIME_RE = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Offset of `timeZone` from UTC in milliseconds at the instant `instant`,
 * positive east of Greenwich (Asia/Almaty → +18_000_000). Derived from the
 * zone, never hardcoded: we render `instant`'s wall clock in `timeZone`,
 * re-read that wall clock as if it were UTC, and take the difference.
 *
 * `hourCycle: 'h23'` is load-bearing. With `hour12: false` — the intuitive
 * spelling — several ICU versions emit hour `24` for local midnight instead of
 * `0`, which would throw the offset out by a full day. We ask for h23 and
 * still normalise 24 → 0 defensively; the `day` part is already the correct
 * day under both spellings, so clamping the hour alone is the right fix.
 */
function zoneOffsetMsAt(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const field: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== 'literal' && part.type !== 'timeZoneName') {
      field[part.type] = parseInt(part.value, 10);
    }
  }

  const wallClockAsUtcMs = Date.UTC(
    field.year,
    field.month - 1,
    field.day,
    field.hour === 24 ? 0 : field.hour,
    field.minute,
    field.second,
  );
  // `wallClockAsUtcMs` carries no sub-second precision, so comparing against a
  // raw getTime() would smear `instant`'s milliseconds into the offset.
  const instantAtWholeSecondMs =
    instant.getTime() - instant.getUTCMilliseconds();
  return wallClockAsUtcMs - instantAtWholeSecondMs;
}

/**
 * Combines the calendar day of `date` **as rendered in `timeZone`** with the
 * naive wall-clock `time` **interpreted in `timeZone`**, and returns the UTC
 * instant that pair denotes. Default timezone Asia/Almaty (UTC+5, no DST) —
 * see `KG_DEFAULT_TIMEZONE`.
 *
 * This is the right way to project a `schedule_template_slots.start_time` (a
 * PG `time` column — no zone, a pure wall clock authored by the kindergarten)
 * onto a concrete date. The naive `new Date(Date.UTC(y, m, d, hh, mm))`
 * spelling it replaces declares the wall clock to *be* UTC, which shifts every
 * Almaty schedule +5h: a slot authored as 08:00 becomes `08:00Z` and renders
 * as 13:00 local in the apps.
 *
 * Accepts `'HH:MM'` and `'HH:MM:SS'` (both zero-padded); throws
 * `InvariantViolationError` on anything else rather than handing back an
 * Invalid Date that only fails much further downstream.
 *
 * Example: a `date` whose Asia/Almaty calendar day is 2026-07-13, combined
 * with `'08:00:00'`, returns `2026-07-13T03:00:00.000Z` (08:00 Almaty = 03:00
 * UTC). The day is taken *in the zone*, so `2026-07-12T19:30:00.000Z` — which
 * is already 2026-07-13T00:30 in Almaty — also yields the 07-13 slot, not the
 * 07-12 one.
 *
 * Example (day-crossing — the case the UTC-naive code got wrong): that same
 * 2026-07-13 Almaty day combined with `'02:00'` returns
 * `2026-07-12T21:00:00.000Z`. An early-morning local slot legitimately lands
 * on the *previous* UTC day.
 *
 * The offset is derived from `timeZone` via `Intl` rather than hardcoded, so
 * the helper stays correct for DST zones and any other IANA identifier.
 */
export function combineDateAndTimeInTimezone(
  date: Date,
  time: string,
  timeZone: string = KG_DEFAULT_TIMEZONE,
): Date {
  if (Number.isNaN(date.getTime())) {
    throw new InvariantViolationError('date must be a valid Date');
  }

  const match = WALL_CLOCK_TIME_RE.exec(time);
  if (!match) {
    throw new InvariantViolationError(
      `time must be HH:MM or HH:MM:SS, got: ${time}`,
    );
  }

  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const seconds = match[3] ? parseInt(match[3], 10) : 0;
  if (hours > 23 || minutes > 59 || seconds > 59) {
    throw new InvariantViolationError(
      `time must be a wall clock in 00:00:00..23:59:59, got: ${time}`,
    );
  }

  // Calendar day *in the zone* — not `date.getUTCDate()`, which names the
  // previous day for any Almaty instant before 05:00 local.
  const [year, month, day] = formatDateInTimezone(date, timeZone)
    .split('-')
    .map((part) => parseInt(part, 10));

  // The wall clock read as if it were UTC. Not the answer: the instant we want
  // is this minus the zone's offset *at that instant*.
  const wallClockAsUtcMs = Date.UTC(
    year,
    month - 1,
    day,
    hours,
    minutes,
    seconds,
  );

  // Fixed-point solve for `t` in `wallClockOf(t) === wallClockAsUtcMs`. One
  // refinement suffices for every real zone: the first guess can only be off
  // if it landed on the far side of a DST transition, and re-reading the
  // offset there brings it back. Fixed-offset zones converge immediately.
  const guessMs =
    wallClockAsUtcMs - zoneOffsetMsAt(new Date(wallClockAsUtcMs), timeZone);
  return new Date(
    wallClockAsUtcMs - zoneOffsetMsAt(new Date(guessMs), timeZone),
  );
}
