import { formatInstantWithOffset } from '@/shared-kernel/domain/value-objects/day-of-week.vo';
import { ActivityEvent } from './domain/entities/activity-event.entity';
import { ScheduleTemplate } from './domain/entities/schedule-template.entity';
import { ScheduleTemplateSlot } from './domain/entities/schedule-template-slot.entity';
import { ScheduleWeekSnapshot } from './domain/entities/schedule-week-snapshot.entity';
import { ActivityEventResponseDto } from './dto/activity-event.response.dto';
import {
  ScheduleTemplateResponseDto,
  ScheduleTemplateSlotResponseDto,
} from './dto/schedule-template.response.dto';
import { ScheduleWeekSnapshotResponseDto } from './dto/week-snapshot.response.dto';

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export class SchedulePresenter {
  static slot(s: ScheduleTemplateSlot): ScheduleTemplateSlotResponseDto {
    const state = s.toState();
    return {
      id: state.id,
      dayOfWeek: state.dayOfWeek,
      startTime: state.startTime,
      endTime: state.endTime,
      activityName: state.activityName,
      category: state.category,
      locationId: state.locationId,
      description: state.description,
    };
  }

  static template(t: ScheduleTemplate): ScheduleTemplateResponseDto {
    const state = t.toState();
    return {
      id: state.id,
      kindergartenId: state.kindergartenId,
      groupId: state.groupId,
      name: state.name,
      recurrence: state.recurrence,
      isActive: state.isActive,
      validFrom: toIsoDate(state.validFrom),
      validUntil:
        state.validUntil === null ? null : toIsoDate(state.validUntil),
      createdAt: state.createdAt.toISOString(),
      slots: state.slots.map((slotState) =>
        SchedulePresenter.slot(ScheduleTemplateSlot.hydrate(slotState)),
      ),
    };
  }

  /**
   * @param locationName Display-name overlay resolved from `locationId →
   *   locations.name` by the service. Defaults to null so callers that have
   *   not resolved an overlay (or the cross-tenant case) render cleanly.
   */
  static event(
    e: ActivityEvent,
    locationName: string | null = null,
  ): ActivityEventResponseDto {
    const s = e.toState();
    return {
      id: s.id,
      kindergartenId: s.kindergartenId,
      groupId: s.groupId,
      templateSlotId: s.templateSlotId,
      origin: s.origin,
      activityName: s.activityName,
      category: s.category,
      locationId: s.locationId,
      location_name: locationName,
      startsAt: formatInstantWithOffset(s.startsAt),
      endsAt: s.endsAt === null ? null : formatInstantWithOffset(s.endsAt),
      status: s.status,
      createdBy: s.createdBy,
      notes: s.notes,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    };
  }

  /**
   * List variant — maps each event, threading a `location_name` overlay from
   * the supplied `names` map (keyed by `locationId`). Events without a
   * location, or whose id has no map entry, render `location_name = null`.
   */
  static events(
    items: ActivityEvent[],
    names?: Map<string, string | null>,
  ): ActivityEventResponseDto[] {
    return items.map((e) =>
      SchedulePresenter.event(
        e,
        e.locationId !== null ? (names?.get(e.locationId) ?? null) : null,
      ),
    );
  }

  static weekSnapshot(
    s: ScheduleWeekSnapshot,
  ): ScheduleWeekSnapshotResponseDto {
    const state = s.toState();
    return {
      id: state.id,
      kindergartenId: state.kindergartenId,
      groupId: state.groupId,
      weekStartDate: toIsoDate(state.weekStartDate),
      source: state.source,
      copiedFrom: state.copiedFrom,
      createdAt: state.createdAt.toISOString(),
    };
  }
}
