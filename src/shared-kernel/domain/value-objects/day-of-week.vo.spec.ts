import {
  KG_DEFAULT_TIMEZONE,
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
});
