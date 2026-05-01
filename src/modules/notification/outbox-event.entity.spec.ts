import {
  defaultBackoff,
  MAX_OUTBOX_ATTEMPTS,
  OutboxEvent,
} from './domain/entities/outbox-event.entity';

describe('OutboxEvent (domain)', () => {
  const baseInput = {
    kindergartenId: 'kg-1',
    eventKey: 'attendance.checkin',
    payload: { childId: 'child-1', recordedAt: '2026-05-01T08:00:00Z' },
  };
  const now = new Date('2026-05-01T08:00:00.000Z');

  describe('create', () => {
    it('returns a pending event with attempts=0 and nextRetryAt=now', () => {
      const ev = OutboxEvent.create(baseInput, now);

      expect(ev.status.value).toBe('pending');
      expect(ev.attempts).toBe(0);
      expect(ev.nextRetryAt.toISOString()).toBe(now.toISOString());
      expect(ev.createdAt.toISOString()).toBe(now.toISOString());
      expect(ev.dispatchedAt).toBeNull();
      expect(ev.failedReason).toBeNull();
      expect(ev.kindergartenId).toBe(baseInput.kindergartenId);
      expect(ev.eventKey).toBe(baseInput.eventKey);
      expect(ev.payload).toEqual(baseInput.payload);
    });

    it('preserves an explicit id when provided', () => {
      const ev = OutboxEvent.create({ ...baseInput, id: 'oe-1' }, now);
      expect(ev.id).toBe('oe-1');
    });

    it('leaves id undefined when omitted (DB default fills it)', () => {
      const ev = OutboxEvent.create(baseInput, now);
      expect(ev.id).toBeUndefined();
    });
  });

  describe('markDispatched', () => {
    it('transitions pending → dispatched and stamps dispatchedAt', () => {
      const ev = OutboxEvent.create(baseInput, now);
      const ts = new Date('2026-05-01T08:00:30.000Z');

      ev.markDispatched(ts);

      expect(ev.status.value).toBe('dispatched');
      expect(ev.dispatchedAt!.toISOString()).toBe(ts.toISOString());
      expect(ev.isTerminal()).toBe(true);
    });

    it('throws when called on an already-dispatched event', () => {
      const ev = OutboxEvent.create(baseInput, now);
      ev.markDispatched(new Date('2026-05-01T08:00:30.000Z'));

      expect(() =>
        ev.markDispatched(new Date('2026-05-01T08:01:00.000Z')),
      ).toThrow(/already_terminal/);
    });

    it('throws when called on a failed (terminal) event', () => {
      const ev = OutboxEvent.create(baseInput, now);
      // drive to terminal failed
      for (let i = 0; i < MAX_OUTBOX_ATTEMPTS; i++) {
        ev.markFailed(now, 'oops');
      }
      expect(ev.status.value).toBe('failed');

      expect(() => ev.markDispatched(now)).toThrow(/already_terminal/);
    });
  });

  describe('markFailed', () => {
    it('increments attempts and reschedules via injected backoff', () => {
      const ev = OutboxEvent.create(baseInput, now);
      const fixedBackoff = (): number => 60_000; // 1 min

      ev.markFailed(now, 'transient', fixedBackoff, 5);

      expect(ev.attempts).toBe(1);
      expect(ev.status.value).toBe('pending');
      expect(ev.nextRetryAt.getTime()).toBe(now.getTime() + 60_000);
      expect(ev.failedReason).toBe('transient');
    });

    it('uses defaultBackoff (2^attempts minutes) when none injected', () => {
      const ev = OutboxEvent.create(baseInput, now);

      ev.markFailed(now, 'transient');

      // attempts=1 → 2 min
      expect(ev.attempts).toBe(1);
      expect(ev.nextRetryAt.getTime() - now.getTime()).toBe(2 * 60_000);
    });

    it('caps defaultBackoff at 60min for very high attempts', () => {
      // attempts=10 → 2^10=1024 capped to 60
      expect(defaultBackoff(10)).toBe(60 * 60_000);
      expect(defaultBackoff(6)).toBe(60 * 60_000);
      // boundary: 2^5 = 32 < 60
      expect(defaultBackoff(5)).toBe(32 * 60_000);
    });

    it('after MAX_OUTBOX_ATTEMPTS reached, marks status=failed (terminal)', () => {
      const ev = OutboxEvent.create(baseInput, now);

      for (let i = 0; i < MAX_OUTBOX_ATTEMPTS - 1; i++) {
        ev.markFailed(now, `attempt-${i + 1}`);
        expect(ev.status.value).toBe('pending');
      }
      // final attempt → terminal
      ev.markFailed(now, 'final');

      expect(ev.attempts).toBe(MAX_OUTBOX_ATTEMPTS);
      expect(ev.status.value).toBe('failed');
      expect(ev.failedReason).toBe('final');
      expect(ev.isTerminal()).toBe(true);
    });

    it('throws when called on a dispatched event', () => {
      const ev = OutboxEvent.create(baseInput, now);
      ev.markDispatched(now);

      expect(() => ev.markFailed(now, 'late')).toThrow(/already_terminal/);
    });
  });

  describe('hydrate / toState', () => {
    it('hydrate then toState round-trips', () => {
      const state = {
        id: 'oe-1',
        kindergartenId: 'kg-1',
        eventKey: 'attendance.checkin',
        payload: { foo: 'bar' },
        status: 'pending' as const,
        attempts: 2,
        nextRetryAt: new Date('2026-05-01T08:10:00.000Z'),
        createdAt: new Date('2026-05-01T08:00:00.000Z'),
        dispatchedAt: null,
        failedReason: 'transient',
      };

      const ev = OutboxEvent.hydrate(state);

      expect(ev.toState()).toEqual(state);
    });
  });
});
