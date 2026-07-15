import { InvariantViolationError } from '@/shared-kernel/domain/errors';
import { InvalidEventTransitionError } from '../errors/invalid-event-transition.error';
import { ActivityEvent } from './activity-event.entity';

const KG = '11111111-1111-1111-1111-111111111111';
const GROUP = '22222222-2222-2222-2222-222222222222';
const EVENT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const SLOT_ID = '33333333-3333-3333-3333-333333333333';
const NOW = new Date('2026-04-30T10:00:00.000Z');
const LATER = new Date('2026-04-30T11:00:00.000Z');

const fixedClock = (when: Date) => ({ now: () => when });

function newScheduled(): ActivityEvent {
  return ActivityEvent.createScheduled(
    {
      id: EVENT_ID,
      kindergartenId: KG,
      groupId: GROUP,
      origin: 'adhoc',
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
          origin: 'adhoc',
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
            origin: 'adhoc',
            activityName: 'Bad',
            startsAt: new Date('2026-05-04T10:00:00.000Z'),
            endsAt: new Date('2026-05-04T09:00:00.000Z'),
          },
          fixedClock(NOW),
        ),
      ).toThrow(InvariantViolationError);
    });
  });

  describe('origin (durable provenance)', () => {
    it('returns the origin passed to createScheduled', () => {
      expect(newScheduled().origin).toBe('adhoc');
    });

    it('returns origin=template for a slot-projected event', () => {
      const e = ActivityEvent.createScheduled(
        {
          id: EVENT_ID,
          kindergartenId: KG,
          groupId: GROUP,
          templateSlotId: SLOT_ID,
          origin: 'template',
          activityName: 'Урок',
          startsAt: new Date('2026-05-04T09:00:00.000Z'),
        },
        fixedClock(NOW),
      );
      expect(e.origin).toBe('template');
      expect(e.templateSlotId).toBe(SLOT_ID);
    });

    it('round-trips origin through toState/hydrate', () => {
      const e = ActivityEvent.createScheduled(
        {
          id: EVENT_ID,
          kindergartenId: KG,
          groupId: GROUP,
          templateSlotId: SLOT_ID,
          origin: 'template',
          activityName: 'Урок',
          startsAt: new Date('2026-05-04T09:00:00.000Z'),
        },
        fixedClock(NOW),
      );
      expect(e.toState().origin).toBe('template');
      expect(ActivityEvent.hydrate(e.toState()).origin).toBe('template');
    });

    /**
     * The whole point of the column: `template_slot_id` is ON DELETE SET NULL,
     * so a template edit nulls the FK on already-materialized events. `origin`
     * must still mark such an orphan as template-born, keeping it distinct from
     * a genuine ad-hoc event (which also has templateSlotId === null).
     */
    it('returns origin=template for an orphan whose slot was deleted', () => {
      const orphan = ActivityEvent.hydrate({
        id: EVENT_ID,
        kindergartenId: KG,
        groupId: GROUP,
        templateSlotId: null,
        origin: 'template',
        activityName: 'Урок',
        category: 'lesson',
        locationId: null,
        startsAt: new Date('2026-05-04T09:00:00.000Z'),
        endsAt: null,
        status: 'scheduled',
        createdBy: null,
        notes: null,
        createdAt: NOW,
        updatedAt: NOW,
      });
      expect(orphan.templateSlotId).toBeNull();
      expect(orphan.origin).toBe('template');
      expect(orphan.origin).not.toBe(newScheduled().origin);
    });

    it('returns an unchanged origin after state transitions and reschedule', () => {
      const e = newScheduled();
      e.reschedule({ activityName: 'Renamed' }, fixedClock(LATER));
      expect(e.origin).toBe('adhoc');
      e.start(fixedClock(LATER));
      expect(e.origin).toBe('adhoc');
      e.complete(fixedClock(LATER));
      expect(e.origin).toBe('adhoc');
    });

    /**
     * Asserted via the descriptor rather than by expecting an assignment to
     * throw: tsconfig sets no `strict`/`alwaysStrict`, so emitted specs are
     * sloppy-mode, where writing to a getter-only property silently no-ops
     * instead of raising TypeError. The descriptor is the deterministic check.
     */
    it('keeps origin immutable — a getter with no setter', () => {
      const descriptor = Object.getOwnPropertyDescriptor(
        ActivityEvent.prototype,
        'origin',
      );
      expect(descriptor?.get).toBeDefined();
      expect(descriptor?.set).toBeUndefined();
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
