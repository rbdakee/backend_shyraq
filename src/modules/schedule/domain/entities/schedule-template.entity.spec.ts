import { InvalidSlotTimeError } from '../errors/invalid-slot-time.error';
import { SlotConflictError } from '../errors/slot-conflict.error';
import { SlotNotFoundError } from '../errors/slot-not-found.error';
import { ScheduleTemplate } from './schedule-template.entity';

const KG = '11111111-1111-1111-1111-111111111111';
const GROUP = '22222222-2222-2222-2222-222222222222';
const TEMPLATE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const SLOT_ID_1 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const SLOT_ID_2 = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const NOW = new Date('2026-04-30T10:00:00.000Z');

const fixedClock = (when: Date) => ({ now: () => when });

function newTemplate(): ScheduleTemplate {
  return ScheduleTemplate.createNew(
    {
      id: TEMPLATE_ID,
      kindergartenId: KG,
      groupId: GROUP,
      name: 'Standard Mon-Fri',
      validFrom: new Date('2026-05-04T00:00:00.000Z'),
    },
    fixedClock(NOW),
  );
}

describe('ScheduleTemplate domain entity', () => {
  describe('createNew', () => {
    it('returns an active template with default recurrence weekly', () => {
      const t = newTemplate();
      expect(t.id).toBe(TEMPLATE_ID);
      expect(t.kindergartenId).toBe(KG);
      expect(t.groupId).toBe(GROUP);
      expect(t.recurrence).toBe('weekly');
      expect(t.isActive).toBe(true);
      expect(t.slots).toHaveLength(0);
      expect(t.createdAt).toEqual(NOW);
    });
  });

  describe('addSlot', () => {
    it('appends a slot when (day, start_time) is unique', () => {
      const t = newTemplate();
      t.addSlot({
        id: SLOT_ID_1,
        dayOfWeek: 'mon',
        startTime: '09:00',
        endTime: '09:45',
        activityName: 'Morning Circle',
      });
      expect(t.slots).toHaveLength(1);
      expect(t.slots[0].activityName).toBe('Morning Circle');
      expect(t.slots[0].startTime).toBe('09:00:00');
      // category omitted → server default 'activity'.
      expect(t.slots[0].category).toBe('activity');
    });

    it('keeps an explicit category and rejects an unknown one', () => {
      const t = newTemplate();
      t.addSlot({
        id: SLOT_ID_1,
        dayOfWeek: 'mon',
        startTime: '13:00',
        endTime: '15:00',
        activityName: 'Тихий час',
        category: 'sleep',
      });
      expect(t.slots[0].category).toBe('sleep');
      expect(() =>
        t.addSlot({
          id: SLOT_ID_2,
          dayOfWeek: 'tue',
          startTime: '09:00',
          endTime: '09:45',
          activityName: 'Bad',
          category: 'nonsense',
        }),
      ).toThrow(/invalid slot category/);
    });

    it('throws SlotConflictError when day+start_time is already used', () => {
      const t = newTemplate();
      t.addSlot({
        id: SLOT_ID_1,
        dayOfWeek: 'mon',
        startTime: '09:00',
        endTime: '09:45',
        activityName: 'Morning Circle',
      });
      expect(() =>
        t.addSlot({
          id: SLOT_ID_2,
          dayOfWeek: 'mon',
          startTime: '09:00',
          endTime: '10:00',
          activityName: 'Yoga',
        }),
      ).toThrow(SlotConflictError);
    });

    it('throws InvalidSlotTimeError when start_time >= end_time', () => {
      const t = newTemplate();
      expect(() =>
        t.addSlot({
          id: SLOT_ID_1,
          dayOfWeek: 'mon',
          startTime: '10:00',
          endTime: '09:00',
          activityName: 'Bad Slot',
        }),
      ).toThrow(InvalidSlotTimeError);
    });

    it('allows two slots on the same day at different times', () => {
      const t = newTemplate();
      t.addSlot({
        id: SLOT_ID_1,
        dayOfWeek: 'mon',
        startTime: '09:00',
        endTime: '09:45',
        activityName: 'Morning Circle',
      });
      t.addSlot({
        id: SLOT_ID_2,
        dayOfWeek: 'mon',
        startTime: '10:00',
        endTime: '11:00',
        activityName: 'IZO',
      });
      expect(t.slots).toHaveLength(2);
    });
  });

  describe('updateSlot', () => {
    it('throws SlotNotFoundError when slot is unknown', () => {
      const t = newTemplate();
      expect(() => t.updateSlot('missing-id', { activityName: 'X' })).toThrow(
        SlotNotFoundError,
      );
    });

    it('rejects a patch that creates a (day, start_time) conflict with another slot', () => {
      const t = newTemplate();
      t.addSlot({
        id: SLOT_ID_1,
        dayOfWeek: 'mon',
        startTime: '09:00',
        endTime: '09:45',
        activityName: 'A',
      });
      t.addSlot({
        id: SLOT_ID_2,
        dayOfWeek: 'mon',
        startTime: '10:00',
        endTime: '11:00',
        activityName: 'B',
      });
      expect(() => t.updateSlot(SLOT_ID_2, { startTime: '09:00' })).toThrow(
        SlotConflictError,
      );
    });

    it('updates fields when no conflict arises', () => {
      const t = newTemplate();
      t.addSlot({
        id: SLOT_ID_1,
        dayOfWeek: 'mon',
        startTime: '09:00',
        endTime: '09:45',
        activityName: 'A',
      });
      t.updateSlot(SLOT_ID_1, { activityName: 'Renamed', endTime: '10:00' });
      expect(t.slots[0].activityName).toBe('Renamed');
      expect(t.slots[0].endTime).toBe('10:00:00');
    });

    it('patches the category without touching the time fields', () => {
      const t = newTemplate();
      t.addSlot({
        id: SLOT_ID_1,
        dayOfWeek: 'mon',
        startTime: '09:00',
        endTime: '09:45',
        activityName: 'A',
      });
      t.updateSlot(SLOT_ID_1, { category: 'meal' });
      expect(t.slots[0].category).toBe('meal');
      expect(t.slots[0].startTime).toBe('09:00:00');
    });
  });

  describe('removeSlot', () => {
    it('drops the slot when present', () => {
      const t = newTemplate();
      t.addSlot({
        id: SLOT_ID_1,
        dayOfWeek: 'mon',
        startTime: '09:00',
        endTime: '09:45',
        activityName: 'A',
      });
      t.removeSlot(SLOT_ID_1);
      expect(t.slots).toHaveLength(0);
    });

    it('throws SlotNotFoundError when slot is unknown', () => {
      const t = newTemplate();
      expect(() => t.removeSlot('nope')).toThrow(SlotNotFoundError);
    });
  });

  describe('activate / deactivate / update', () => {
    it('toggles the active flag', () => {
      const t = newTemplate();
      t.deactivate();
      expect(t.isActive).toBe(false);
      t.activate();
      expect(t.isActive).toBe(true);
    });

    it('updates name and validUntil', () => {
      const t = newTemplate();
      t.update({ name: 'Renamed', validUntil: new Date('2026-09-01') });
      expect(t.name).toBe('Renamed');
      expect(t.validUntil).toEqual(new Date('2026-09-01'));
    });
  });
});
