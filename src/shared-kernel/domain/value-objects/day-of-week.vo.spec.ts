import { InvariantViolationError } from '../errors/invariant-violation.error';
import {
  KG_DEFAULT_TIMEZONE,
  combineDateAndTimeInTimezone,
  dayOfWeekFromIsoWeekday,
  firstOfMonthInTimezone,
  formatDateInTimezone,
  isWeekendDay,
  isoWeekdayOf,
  startOfDayInTimezone,
  todayInTimezone,
} from './day-of-week.vo';

describe('day-of-week timezone helpers (Asia/Almaty)', () => {
  describe('KG_DEFAULT_TIMEZONE', () => {
    it('exports Asia/Almaty as the single-region default', () => {
      expect(KG_DEFAULT_TIMEZONE).toBe('Asia/Almaty');
    });
  });

  describe('dayOfWeekFromIsoWeekday', () => {
    it.each([
      [1, 'mon'],
      [2, 'tue'],
      [3, 'wed'],
      [4, 'thu'],
      [5, 'fri'],
      [6, 'sat'],
      [7, 'sun'],
    ])('maps iso=%i → %s', (iso, expected) => {
      expect(dayOfWeekFromIsoWeekday(iso)).toBe(expected);
    });

    it.each([[0], [8], [-1], [1.5]])('throws on out-of-range %p', (raw) => {
      expect(() => dayOfWeekFromIsoWeekday(raw)).toThrow();
    });
  });

  describe('formatDateInTimezone', () => {
    it('returns same calendar day when UTC time is before Almaty midnight rollover', () => {
      // 2026-05-12T18:30:00Z = 2026-05-12T23:30 Asia/Almaty
      const d = new Date('2026-05-12T18:30:00.000Z');
      expect(formatDateInTimezone(d, 'Asia/Almaty')).toBe('2026-05-12');
    });

    it('rolls forward to next calendar day after Almaty midnight (UTC still previous day)', () => {
      // 2026-05-12T19:30:00Z = 2026-05-13T00:30 Asia/Almaty (next day)
      const d = new Date('2026-05-12T19:30:00.000Z');
      expect(formatDateInTimezone(d, 'Asia/Almaty')).toBe('2026-05-13');
    });

    it('crosses a year boundary at Almaty midnight', () => {
      // 2025-12-31T19:30:00Z = 2026-01-01T00:30 Asia/Almaty
      const d = new Date('2025-12-31T19:30:00.000Z');
      expect(formatDateInTimezone(d, 'Asia/Almaty')).toBe('2026-01-01');
    });

    it('honours explicit UTC override', () => {
      const d = new Date('2026-05-12T19:30:00.000Z');
      expect(formatDateInTimezone(d, 'UTC')).toBe('2026-05-12');
    });

    it('defaults to Asia/Almaty when timezone omitted', () => {
      // 19:30Z = 00:30 Almaty next day → with default Asia/Almaty we get the
      // rolled-forward date; the bare UTC formatter would still say 2026-05-12.
      const d = new Date('2026-05-12T19:30:00.000Z');
      expect(formatDateInTimezone(d)).toBe('2026-05-13');
      // sanity: same as passing the constant explicitly
      expect(formatDateInTimezone(d)).toBe(
        formatDateInTimezone(d, KG_DEFAULT_TIMEZONE),
      );
    });
  });

  describe('todayInTimezone', () => {
    it('returns a YYYY-MM-DD string', () => {
      const out = todayInTimezone('Asia/Almaty');
      expect(out).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('matches formatDateInTimezone(new Date()) within a 1-second drift', () => {
      const before = formatDateInTimezone(new Date(), 'Asia/Almaty');
      const out = todayInTimezone('Asia/Almaty');
      const after = formatDateInTimezone(new Date(), 'Asia/Almaty');
      // either the call straddled midnight (rare) or all three agree
      expect([before, after]).toContain(out);
    });
  });

  describe('startOfDayInTimezone', () => {
    it('returns midnight UTC of the Almaty calendar date for late-evening UTC', () => {
      // 2026-05-12T19:30:00Z = 2026-05-13T00:30 Almaty → start-of-day is
      // midnight UTC of 2026-05-13 (an opaque marker for the calendar date).
      const d = new Date('2026-05-12T19:30:00.000Z');
      expect(startOfDayInTimezone(d, 'Asia/Almaty').toISOString()).toBe(
        '2026-05-13T00:00:00.000Z',
      );
    });

    it('does NOT roll for late-afternoon UTC (still same Almaty day)', () => {
      // 2026-05-12T18:30:00Z = 2026-05-12T23:30 Almaty
      const d = new Date('2026-05-12T18:30:00.000Z');
      expect(startOfDayInTimezone(d, 'Asia/Almaty').toISOString()).toBe(
        '2026-05-12T00:00:00.000Z',
      );
    });
  });

  describe('firstOfMonthInTimezone', () => {
    it('returns first-of-month for a mid-month date in Almaty', () => {
      const d = new Date('2026-05-12T05:00:00.000Z');
      expect(firstOfMonthInTimezone(d, 'Asia/Almaty').toISOString()).toBe(
        '2026-05-01T00:00:00.000Z',
      );
    });

    it('rolls forward to next month when UTC is end-of-month-22:00 but Almaty is already next month', () => {
      // 2026-05-31T22:00:00Z = 2026-06-01T03:00 Almaty → June period
      const d = new Date('2026-05-31T22:00:00.000Z');
      expect(firstOfMonthInTimezone(d, 'Asia/Almaty').toISOString()).toBe(
        '2026-06-01T00:00:00.000Z',
      );
    });

    it('does NOT roll forward when UTC end-of-month-18:00 is still same Almaty month', () => {
      // 2026-05-31T18:00:00Z = 2026-05-31T23:00 Almaty → still May
      const d = new Date('2026-05-31T18:00:00.000Z');
      expect(firstOfMonthInTimezone(d, 'Asia/Almaty').toISOString()).toBe(
        '2026-05-01T00:00:00.000Z',
      );
    });

    it('crosses a year boundary correctly', () => {
      // 2026-12-31T22:00:00Z = 2027-01-01T03:00 Almaty → January 2027
      const d = new Date('2026-12-31T22:00:00.000Z');
      expect(firstOfMonthInTimezone(d, 'Asia/Almaty').toISOString()).toBe(
        '2027-01-01T00:00:00.000Z',
      );
    });

    it('honours UTC override (matches the legacy startOfMonth helper semantics)', () => {
      const d = new Date('2026-05-31T22:00:00.000Z');
      expect(firstOfMonthInTimezone(d, 'UTC').toISOString()).toBe(
        '2026-05-01T00:00:00.000Z',
      );
    });
  });

  describe('isoWeekdayOf', () => {
    it('returns 7 for Sunday-night Almaty (UTC still shows Sunday afternoon)', () => {
      // Sunday 2026-05-10T18:00:00Z = Sunday 2026-05-10T23:00 Almaty → iso=7
      const sun = new Date('2026-05-10T18:00:00.000Z');
      expect(isoWeekdayOf(sun, 'Asia/Almaty')).toBe(7);
    });

    it('returns 1 for Sunday-late-night Almaty when UTC still says Sunday but Almaty is Monday', () => {
      // 2026-05-10T19:30:00Z = Monday 2026-05-11T00:30 Almaty → iso=1
      const monAlmaty = new Date('2026-05-10T19:30:00.000Z');
      expect(isoWeekdayOf(monAlmaty, 'Asia/Almaty')).toBe(1);
    });

    it.each([
      // Mid-day samples to confirm Mon=1 … Sun=7 mapping in Almaty
      ['2026-05-04T07:00:00.000Z', 1], // Mon
      ['2026-05-05T07:00:00.000Z', 2], // Tue
      ['2026-05-06T07:00:00.000Z', 3], // Wed
      ['2026-05-07T07:00:00.000Z', 4], // Thu
      ['2026-05-08T07:00:00.000Z', 5], // Fri
      ['2026-05-09T07:00:00.000Z', 6], // Sat
      ['2026-05-10T07:00:00.000Z', 7], // Sun
    ])('maps Almaty wall-clock %s → iso=%i', (iso, expected) => {
      expect(isoWeekdayOf(new Date(iso), 'Asia/Almaty')).toBe(expected);
    });
  });

  describe('isWeekendDay', () => {
    it('returns true for Saturday Almaty', () => {
      const sat = new Date('2026-05-09T07:00:00.000Z');
      expect(isWeekendDay(sat, 'Asia/Almaty')).toBe(true);
    });

    it('returns true for Sunday Almaty', () => {
      const sun = new Date('2026-05-10T07:00:00.000Z');
      expect(isWeekendDay(sun, 'Asia/Almaty')).toBe(true);
    });

    it('returns false for Friday Almaty', () => {
      const fri = new Date('2026-05-08T07:00:00.000Z');
      expect(isWeekendDay(fri, 'Asia/Almaty')).toBe(false);
    });

    it('returns true when UTC says Sunday-evening but Almaty has crossed into Monday — Monday is NOT weekend', () => {
      // 2026-05-10T19:30:00Z = Monday 2026-05-11T00:30 Almaty
      const monAlmaty = new Date('2026-05-10T19:30:00.000Z');
      expect(isWeekendDay(monAlmaty, 'Asia/Almaty')).toBe(false);
    });
  });

  describe('combineDateAndTimeInTimezone', () => {
    // Mid-day anchor: 2026-07-13T06:00:00Z = 2026-07-13T11:00 Almaty, so the
    // calendar day is unambiguously 2026-07-13 in both UTC and Almaty.
    const jul13 = new Date('2026-07-13T06:00:00.000Z');

    it('returns 03:00Z for an 08:00 Almaty schedule slot', () => {
      // The bug this helper fixes: the old UTC-naive combine returned
      // 2026-07-13T08:00:00Z, which renders as 13:00 local (+5h shift).
      expect(
        combineDateAndTimeInTimezone(jul13, '08:00:00', 'Asia/Almaty'),
      ).toEqual(new Date('2026-07-13T03:00:00.000Z'));
    });

    it('returns the same instant for HH:MM and HH:MM:SS forms', () => {
      expect(
        combineDateAndTimeInTimezone(jul13, '08:00', 'Asia/Almaty'),
      ).toEqual(combineDateAndTimeInTimezone(jul13, '08:00:00', 'Asia/Almaty'));
    });

    it('returns an instant carrying the seconds component of HH:MM:SS', () => {
      expect(
        combineDateAndTimeInTimezone(jul13, '08:30:45', 'Asia/Almaty'),
      ).toEqual(new Date('2026-07-13T03:30:45.000Z'));
    });

    it('returns the previous UTC day for Almaty midnight', () => {
      // 00:00 Almaty on 07-13 = 19:00Z on 07-12. Also guards the hour-24 ICU
      // pitfall: the resolved instant renders as local midnight.
      expect(
        combineDateAndTimeInTimezone(jul13, '00:00', 'Asia/Almaty'),
      ).toEqual(new Date('2026-07-12T19:00:00.000Z'));
    });

    it('returns the previous UTC day for an early-morning Almaty slot', () => {
      // 02:00 Almaty on 07-13 = 21:00Z on 07-12 — the day-crossing case the
      // UTC-naive code got wrong (it said 2026-07-13T02:00:00Z).
      expect(
        combineDateAndTimeInTimezone(jul13, '02:00', 'Asia/Almaty'),
      ).toEqual(new Date('2026-07-12T21:00:00.000Z'));
    });

    it('returns the last slot of the Almaty day for 23:59:59', () => {
      expect(
        combineDateAndTimeInTimezone(jul13, '23:59:59', 'Asia/Almaty'),
      ).toEqual(new Date('2026-07-13T18:59:59.000Z'));
    });

    it('returns a slot on the Almaty calendar day, not the UTC one', () => {
      // 2026-07-12T19:30:00Z is already 2026-07-13T00:30 in Almaty, so the
      // slot belongs to 07-13 even though getUTCDate() would say 07-12.
      const rolledOver = new Date('2026-07-12T19:30:00.000Z');
      expect(
        combineDateAndTimeInTimezone(rolledOver, '08:00:00', 'Asia/Almaty'),
      ).toEqual(new Date('2026-07-13T03:00:00.000Z'));
    });

    it('returns the same instant regardless of the time-of-day of the input date', () => {
      // Only the calendar day of `date` matters; its clock component is dropped.
      const early = new Date('2026-07-13T00:00:00.000Z'); // 05:00 Almaty 07-13
      const late = new Date('2026-07-13T18:00:00.000Z'); // 23:00 Almaty 07-13
      expect(
        combineDateAndTimeInTimezone(early, '08:00:00', 'Asia/Almaty'),
      ).toEqual(combineDateAndTimeInTimezone(late, '08:00:00', 'Asia/Almaty'));
    });

    it('defaults to Asia/Almaty when timezone omitted', () => {
      expect(combineDateAndTimeInTimezone(jul13, '08:00:00')).toEqual(
        combineDateAndTimeInTimezone(jul13, '08:00:00', KG_DEFAULT_TIMEZONE),
      );
      expect(combineDateAndTimeInTimezone(jul13, '08:00:00')).toEqual(
        new Date('2026-07-13T03:00:00.000Z'),
      );
    });

    it('returns the wall clock unshifted for UTC (identity zone)', () => {
      expect(combineDateAndTimeInTimezone(jul13, '08:00:00', 'UTC')).toEqual(
        new Date('2026-07-13T08:00:00.000Z'),
      );
    });

    it('returns a forward-shifted instant for a negative-offset zone (EDT, UTC-4)', () => {
      // Proves the offset is derived, not a hardcoded +5. 2026-07-13T16:00:00Z
      // = 12:00 New York on 07-13 → 08:00 EDT = 12:00Z.
      const nyJul13 = new Date('2026-07-13T16:00:00.000Z');
      expect(
        combineDateAndTimeInTimezone(nyJul13, '08:00:00', 'America/New_York'),
      ).toEqual(new Date('2026-07-13T12:00:00.000Z'));
    });

    it('returns a different UTC offset for the same zone in winter (EST, UTC-5)', () => {
      // Same zone + same wall clock, five months earlier: 08:00 EST = 13:00Z,
      // not 12:00Z. A per-zone constant could not produce both.
      const nyJan13 = new Date('2026-01-13T17:00:00.000Z');
      expect(
        combineDateAndTimeInTimezone(nyJan13, '08:00:00', 'America/New_York'),
      ).toEqual(new Date('2026-01-13T13:00:00.000Z'));
    });

    it('returns the post-transition offset on a spring-forward DST day', () => {
      // 2026-03-08 is the US spring-forward date (02:00 EST → 03:00 EDT). An
      // 08:00 local slot is already EDT → 12:00Z. Exercises the refinement
      // step: the first offset probe reads the zone at the naive wall clock.
      const nyDstDay = new Date('2026-03-08T17:00:00.000Z');
      expect(
        combineDateAndTimeInTimezone(nyDstDay, '08:00:00', 'America/New_York'),
      ).toEqual(new Date('2026-03-08T12:00:00.000Z'));
    });

    it.each([
      ['8:00'],
      ['08:00:00.500'],
      ['0800'],
      ['08-00'],
      ['08:00:'],
      ['abc'],
      [''],
      ['08:00:00 '],
    ])('throws InvariantViolationError on malformed time %p', (raw) => {
      expect(() =>
        combineDateAndTimeInTimezone(jul13, raw, 'Asia/Almaty'),
      ).toThrow(InvariantViolationError);
    });

    it.each([['24:00:00'], ['08:60'], ['08:00:60'], ['99:99:99']])(
      'throws on out-of-range wall clock %p',
      (raw) => {
        expect(() =>
          combineDateAndTimeInTimezone(jul13, raw, 'Asia/Almaty'),
        ).toThrow(InvariantViolationError);
      },
    );

    it('throws on an Invalid Date rather than returning one', () => {
      expect(() =>
        combineDateAndTimeInTimezone(
          new Date('nonsense'),
          '08:00:00',
          'Asia/Almaty',
        ),
      ).toThrow(InvariantViolationError);
    });
  });
});
