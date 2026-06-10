import { InvariantViolationError } from '@/shared-kernel/domain/errors';
import { InvalidEventTransitionError } from '../errors/invalid-event-transition.error';
import { ActivityEvent } from './activity-event.entity';

const KG = '11111111-1111-1111-1111-111111111111';
const GROUP = '22222222-2222-2222-2222-222222222222';
const EVENT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const NOW = new Date('2026-04-30T10:00:00.000Z');
const LATER = new Date('2026-04-30T11:00:00.000Z');

const fixedClock = (when: Date) => ({ now: () => when });

function newScheduled(): ActivityEvent {
  return ActivityEvent.createScheduled(
    {
      id: EVENT_ID,
      kindergartenId: KG,
      groupId: GROUP,
      activityName: 'Morning Circle',
      startsAt: new Date('2026-05-04T09:00:00.000Z'),
      endsAt: new Date('2026-05-04T09:45:00.000Z'),
    },
    fixedClock(NOW),
  );
}

describe('ActivityEvent domain entity', () => {
  describe('createScheduled', () => {
    it('returns a scheduled event with timestamps from the clock', () => {
      const e = newScheduled();
      expect(e.id).toBe(EVENT_ID);
      expect(e.status.value).toBe('scheduled');
      expect(e.createdAt).toEqual(NOW);
      expect(e.updatedAt).toEqual(NOW);
      // category omitted → server default 'activity'.
      expect(e.category).toBe('activity');
    });

    it('keeps an explicit category', () => {
      const e = ActivityEvent.createScheduled(
        {
          id: EVENT_ID,
          kindergartenId: KG,
          groupId: GROUP,
          activityName: 'Обед',
          category: 'meal',
          startsAt: new Date('2026-05-04T12:00:00.000Z'),
        },
        fixedClock(NOW),
      );
      expect(e.category).toBe('meal');
    });

    it('throws InvariantViolationError when ends_at <= starts_at', () => {
      expect(() =>
        ActivityEvent.createScheduled(
          {
            id: EVENT_ID,
            kindergartenId: KG,
            groupId: GROUP,
            activityName: 'Bad',
            startsAt: new Date('2026-05-04T10:00:00.000Z'),
            endsAt: new Date('2026-05-04T09:00:00.000Z'),
          },
          fixedClock(NOW),
        ),
      ).toThrow(InvariantViolationError);
    });
  });

  describe('state machine — valid edges', () => {
    it('moves scheduled → in_progress on start()', () => {
      const e = newScheduled();
      e.start(fixedClock(LATER));
      expect(e.status.value).toBe('in_progress');
      expect(e.updatedAt).toEqual(LATER);
    });

    it('moves in_progress → completed on complete()', () => {
      const e = newScheduled();
      e.start(fixedClock(LATER));
      e.complete(fixedClock(LATER));
      expect(e.status.value).toBe('completed');
    });

    it('moves scheduled → cancelled on cancel(reason)', () => {
      const e = newScheduled();
      e.cancel('weather', fixedClock(LATER));
      expect(e.status.value).toBe('cancelled');
      expect(e.notes).toMatch(/cancelled: weather/);
    });

    it('moves in_progress → cancelled on cancel(reason)', () => {
      const e = newScheduled();
      e.start(fixedClock(LATER));
      e.cancel('lockdown', fixedClock(LATER));
      expect(e.status.value).toBe('cancelled');
    });
  });

  describe('state machine — invalid edges', () => {
    it('throws on start() when not scheduled', () => {
      const e = newScheduled();
      e.start(fixedClock(LATER));
      expect(() => e.start(fixedClock(LATER))).toThrow(
        InvalidEventTransitionError,
      );
    });

    it('throws on complete() when scheduled (must start first)', () => {
      const e = newScheduled();
      expect(() => e.complete(fixedClock(LATER))).toThrow(
        InvalidEventTransitionError,
      );
    });

    it('throws on complete() once completed', () => {
      const e = newScheduled();
      e.start(fixedClock(LATER));
      e.complete(fixedClock(LATER));
      expect(() => e.complete(fixedClock(LATER))).toThrow(
        InvalidEventTransitionError,
      );
    });

    it('throws on cancel() once completed', () => {
      const e = newScheduled();
      e.start(fixedClock(LATER));
      e.complete(fixedClock(LATER));
      expect(() => e.cancel('late', fixedClock(LATER))).toThrow(
        InvalidEventTransitionError,
      );
    });

    it('throws on cancel() once cancelled', () => {
      const e = newScheduled();
      e.cancel('weather', fixedClock(LATER));
      expect(() => e.cancel('again', fixedClock(LATER))).toThrow(
        InvalidEventTransitionError,
      );
    });

    it('throws on start() once cancelled', () => {
      const e = newScheduled();
      e.cancel('weather', fixedClock(LATER));
      expect(() => e.start(fixedClock(LATER))).toThrow(
        InvalidEventTransitionError,
      );
    });
  });

  describe('reschedule', () => {
    it('updates fields when status is scheduled', () => {
      const e = newScheduled();
      const newStart = new Date('2026-05-04T10:00:00.000Z');
      const newEnd = new Date('2026-05-04T11:00:00.000Z');
      e.reschedule(
        {
          activityName: 'New',
          category: 'lesson',
          startsAt: newStart,
          endsAt: newEnd,
        },
        fixedClock(LATER),
      );
      expect(e.activityName).toBe('New');
      expect(e.category).toBe('lesson');
      expect(e.startsAt).toEqual(newStart);
      expect(e.endsAt).toEqual(newEnd);
    });

    it('throws InvalidEventTransitionError when status is in_progress', () => {
      const e = newScheduled();
      e.start(fixedClock(LATER));
      expect(() =>
        e.reschedule({ activityName: 'X' }, fixedClock(LATER)),
      ).toThrow(InvalidEventTransitionError);
    });
  });
});
