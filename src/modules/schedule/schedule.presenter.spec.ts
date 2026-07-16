import {
  ActivityEvent,
  ActivityEventState,
} from './domain/entities/activity-event.entity';
import { SchedulePresenter } from './schedule.presenter';

const KG = 'f1a2b3c4-0000-0000-0000-000000000001';
const GROUP = 'a1b2c3d4-0000-0000-0000-000000000010';

function makeEvent(overrides: Partial<ActivityEventState> = {}): ActivityEvent {
  return ActivityEvent.hydrate({
    id: 'e1a2b3c4-0000-0000-0000-000000000001',
    kindergartenId: KG,
    groupId: GROUP,
    templateSlotId: null,
    origin: 'adhoc',
    activityName: 'Утренний круг',
    category: 'activity',
    locationId: null,
    startsAt: new Date('2026-07-13T03:00:00.000Z'),
    endsAt: new Date('2026-07-13T03:45:00.000Z'),
    status: 'scheduled',
    createdBy: null,
    notes: null,
    createdAt: new Date('2026-07-10T10:00:00.000Z'),
    updatedAt: new Date('2026-07-10T10:00:00.000Z'),
    ...overrides,
  });
}

describe('SchedulePresenter.event', () => {
  it('returns startsAt in the Almaty timezone with a +05:00 offset', () => {
    // 03:00Z = 08:00 Asia/Almaty — same instant, local wall clock.
    expect(SchedulePresenter.event(makeEvent()).startsAt).toBe(
      '2026-07-13T08:00:00.000+05:00',
    );
  });

  it('returns endsAt in the Almaty timezone with a +05:00 offset', () => {
    expect(SchedulePresenter.event(makeEvent()).endsAt).toBe(
      '2026-07-13T08:45:00.000+05:00',
    );
  });

  it('returns endsAt null when the event has no end instant', () => {
    expect(SchedulePresenter.event(makeEvent({ endsAt: null })).endsAt).toBe(
      null,
    );
  });

  it('returns createdAt/updatedAt as UTC Z timestamps (audit fields unchanged)', () => {
    const dto = SchedulePresenter.event(makeEvent());
    expect(dto.createdAt).toBe('2026-07-10T10:00:00.000Z');
    expect(dto.updatedAt).toBe('2026-07-10T10:00:00.000Z');
  });
});
