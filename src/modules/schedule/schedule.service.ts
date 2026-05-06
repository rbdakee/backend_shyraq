import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ChildNotFoundError } from '@/modules/child/domain/errors/child-not-found.error';
import { ChildRepository } from '@/modules/child/infrastructure/persistence/child.repository';
import { GroupNotFoundError } from '@/modules/group/domain/errors/group-not-found.error';
import { GroupRepository } from '@/modules/group/infrastructure/persistence/group.repository';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { InvariantViolationError } from '@/shared-kernel/domain/errors';
import { ActivityEvent } from './domain/entities/activity-event.entity';
import { ScheduleTemplate } from './domain/entities/schedule-template.entity';
import {
  ScheduleWeekSnapshot,
  WeekSnapshotSource,
} from './domain/entities/schedule-week-snapshot.entity';
import { ActivityEventNotFoundError } from './domain/errors/activity-event-not-found.error';
import { EventNotDeletableError } from './domain/errors/event-not-deletable.error';
import { EventTransitionConflictError } from './domain/errors/event-transition-conflict.error';
import { ScheduleTemplateNotFoundError } from './domain/errors/schedule-template-not-found.error';
import { isoWeekdayOf } from '@/shared-kernel/domain/value-objects/day-of-week.vo';
import { ActivityEventStatusValue } from './domain/value-objects/activity-event-status.vo';
import {
  ActivityEventRepository,
  ListActivityEventsFilter,
} from './infrastructure/persistence/activity-event.repository';
import {
  ListScheduleTemplatesFilter,
  ScheduleTemplateRepository,
} from './infrastructure/persistence/schedule-template.repository';
import {
  ListScheduleWeekSnapshotsFilter,
  ScheduleWeekSnapshotRepository,
} from './infrastructure/persistence/schedule-week-snapshot.repository';

export interface CreateTemplateInput {
  groupId?: string | null;
  name: string;
  recurrence?: string;
  validFrom: Date;
  validUntil?: Date | null;
  isActive?: boolean;
}

export interface UpdateTemplatePatch {
  name?: string;
  isActive?: boolean;
  validUntil?: Date | null;
}

export interface AddSlotInput {
  dayOfWeek: string;
  startTime: string;
  endTime: string;
  activityName: string;
  locationId?: string | null;
  description?: string | null;
}

export interface UpdateSlotPatch {
  dayOfWeek?: string;
  startTime?: string;
  endTime?: string;
  activityName?: string;
  locationId?: string | null;
  description?: string | null;
}

export interface CreateAdHocEventInput {
  groupId: string;
  activityName: string;
  locationId?: string | null;
  startsAt: Date;
  endsAt?: Date | null;
  notes?: string | null;
  createdByStaffId?: string | null;
}

export interface UpdateEventPatch {
  activityName?: string;
  locationId?: string | null;
  startsAt?: Date;
  endsAt?: Date | null;
  notes?: string | null;
}

export interface CopyWeekResult {
  copiedGroups: number;
  skippedGroups: number;
  totalEvents: number;
  snapshots: ScheduleWeekSnapshot[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * ScheduleService — single entry point for the B7 schedule aggregate.
 *
 * Layout:
 *   - admin/staff methods take an explicit `kindergartenId: string` and rely
 *     on the controller chain (JwtAuthGuard → KindergartenScopeGuard →
 *     RolesGuard) for role enforcement.
 *   - parent path takes `kindergartenId` AND `childId`; the per-row
 *     `ChildAccessGuard` mounted on `parent-schedule.controller.ts` enforces
 *     approved-guardian status, the service then resolves the child's
 *     current_group_id and projects the week.
 *
 * Transactions:
 *   The service does NOT open its own `dataSource.transaction(...)`. The
 *   request is already running inside the ambient TX opened by
 *   `TenantContextInterceptor`, so multi-step flows (template create+slots,
 *   copyWeekToNext snapshot+events) are atomic per-request.
 *
 * State machine on `ActivityEvent` (B7 BP §9.3):
 *   scheduled   → in_progress | cancelled
 *   in_progress → completed   | cancelled
 *   completed   → terminal
 *   cancelled   → terminal
 */
@Injectable()
export class ScheduleService {
  constructor(
    private readonly templateRepo: ScheduleTemplateRepository,
    private readonly eventRepo: ActivityEventRepository,
    private readonly snapshotRepo: ScheduleWeekSnapshotRepository,
    private readonly groupRepo: GroupRepository,
    private readonly childRepo: ChildRepository,
    @Inject(ClockPort) private readonly clock: ClockPort,
  ) {}

  // ── Templates ────────────────────────────────────────────────────────────

  async createTemplate(
    kindergartenId: string,
    input: CreateTemplateInput,
  ): Promise<ScheduleTemplate> {
    if (
      input.validUntil !== undefined &&
      input.validUntil !== null &&
      input.validUntil.getTime() < input.validFrom.getTime()
    ) {
      throw new InvariantViolationError(
        `valid_until must be >= valid_from (${input.validFrom.toISOString()} → ${input.validUntil.toISOString()})`,
      );
    }
    if (input.groupId !== undefined && input.groupId !== null) {
      const group = await this.groupRepo.findById(
        kindergartenId,
        input.groupId,
      );
      if (group === null) throw new GroupNotFoundError(input.groupId);
    }
    const template = ScheduleTemplate.createNew(
      {
        id: randomUUID(),
        kindergartenId,
        groupId: input.groupId ?? null,
        name: input.name,
        recurrence: input.recurrence,
        validFrom: input.validFrom,
        validUntil: input.validUntil ?? null,
      },
      this.clock,
    );
    if (input.isActive === false) template.deactivate();
    return await this.templateRepo.create(kindergartenId, template);
  }

  async updateTemplate(
    kindergartenId: string,
    templateId: string,
    patch: UpdateTemplatePatch,
  ): Promise<ScheduleTemplate> {
    const template = await this.requireTemplate(kindergartenId, templateId);
    template.update(patch);
    return await this.templateRepo.save(kindergartenId, template);
  }

  async getTemplate(
    kindergartenId: string,
    templateId: string,
  ): Promise<ScheduleTemplate> {
    return await this.requireTemplate(kindergartenId, templateId);
  }

  async listTemplates(
    kindergartenId: string,
    filter: ListScheduleTemplatesFilter,
  ): Promise<ScheduleTemplate[]> {
    return await this.templateRepo.list(kindergartenId, filter);
  }

  async deleteTemplate(
    kindergartenId: string,
    templateId: string,
  ): Promise<void> {
    await this.requireTemplate(kindergartenId, templateId);
    await this.templateRepo.delete(kindergartenId, templateId);
  }

  // ── Slots ────────────────────────────────────────────────────────────────

  async addSlot(
    kindergartenId: string,
    templateId: string,
    input: AddSlotInput,
  ): Promise<ScheduleTemplate> {
    const template = await this.requireTemplate(kindergartenId, templateId);
    template.addSlot({
      id: randomUUID(),
      dayOfWeek: input.dayOfWeek,
      startTime: input.startTime,
      endTime: input.endTime,
      activityName: input.activityName,
      locationId: input.locationId ?? null,
      description: input.description ?? null,
    });
    return await this.templateRepo.save(kindergartenId, template);
  }

  async updateSlot(
    kindergartenId: string,
    templateId: string,
    slotId: string,
    patch: UpdateSlotPatch,
  ): Promise<ScheduleTemplate> {
    const template = await this.requireTemplate(kindergartenId, templateId);
    template.updateSlot(slotId, patch);
    return await this.templateRepo.save(kindergartenId, template);
  }

  async removeSlot(
    kindergartenId: string,
    templateId: string,
    slotId: string,
  ): Promise<ScheduleTemplate> {
    const template = await this.requireTemplate(kindergartenId, templateId);
    template.removeSlot(slotId);
    return await this.templateRepo.save(kindergartenId, template);
  }

  // ── Activity events ─────────────────────────────────────────────────────

  async createAdHocEvent(
    kindergartenId: string,
    input: CreateAdHocEventInput,
  ): Promise<ActivityEvent> {
    const group = await this.groupRepo.findById(kindergartenId, input.groupId);
    if (group === null) throw new GroupNotFoundError(input.groupId);
    const event = ActivityEvent.createScheduled(
      {
        id: randomUUID(),
        kindergartenId,
        groupId: input.groupId,
        templateSlotId: null,
        activityName: input.activityName,
        locationId: input.locationId ?? null,
        startsAt: input.startsAt,
        endsAt: input.endsAt ?? null,
        createdBy: input.createdByStaffId ?? null,
        notes: input.notes ?? null,
      },
      this.clock,
    );
    return await this.eventRepo.create(kindergartenId, event);
  }

  async updateEvent(
    kindergartenId: string,
    eventId: string,
    patch: UpdateEventPatch,
  ): Promise<ActivityEvent> {
    const event = await this.requireEvent(kindergartenId, eventId);
    event.reschedule(patch, this.clock);
    return await this.eventRepo.update(kindergartenId, event);
  }

  async deleteEvent(kindergartenId: string, eventId: string): Promise<void> {
    const event = await this.requireEvent(kindergartenId, eventId);
    if (event.status.value !== 'scheduled') {
      throw new EventNotDeletableError(event.status.value);
    }
    await this.eventRepo.delete(kindergartenId, eventId);
  }

  async listEvents(
    kindergartenId: string,
    filter: ListActivityEventsFilter,
  ): Promise<ActivityEvent[]> {
    return await this.eventRepo.list(kindergartenId, filter);
  }

  async getEvent(
    kindergartenId: string,
    eventId: string,
  ): Promise<ActivityEvent> {
    return await this.requireEvent(kindergartenId, eventId);
  }

  async startEvent(
    kindergartenId: string,
    eventId: string,
  ): Promise<ActivityEvent> {
    const event = await this.requireEvent(kindergartenId, eventId);
    const expectedOldStatus = event.status.value;
    event.start(this.clock);
    return await this.persistTransition(
      kindergartenId,
      event,
      expectedOldStatus,
    );
  }

  async completeEvent(
    kindergartenId: string,
    eventId: string,
  ): Promise<ActivityEvent> {
    const event = await this.requireEvent(kindergartenId, eventId);
    const expectedOldStatus = event.status.value;
    event.complete(this.clock);
    return await this.persistTransition(
      kindergartenId,
      event,
      expectedOldStatus,
    );
  }

  async cancelEvent(
    kindergartenId: string,
    eventId: string,
    reason: string,
  ): Promise<ActivityEvent> {
    const event = await this.requireEvent(kindergartenId, eventId);
    const expectedOldStatus = event.status.value;
    event.cancel(reason, this.clock);
    return await this.persistTransition(
      kindergartenId,
      event,
      expectedOldStatus,
    );
  }

  // ── Snapshots & week views ──────────────────────────────────────────────

  async listWeekSnapshots(
    kindergartenId: string,
    filter: ListScheduleWeekSnapshotsFilter,
  ): Promise<ScheduleWeekSnapshot[]> {
    return await this.snapshotRepo.list(kindergartenId, filter);
  }

  /**
   * Per-group week view. Used by staff `/staff/schedule/week`.
   */
  async getGroupWeek(
    kindergartenId: string,
    groupId: string,
    weekStart: Date,
  ): Promise<{ weekStart: Date; events: ActivityEvent[] }> {
    const monday = startOfIsoWeek(weekStart);
    const nextMonday = new Date(monday.getTime() + 7 * DAY_MS);
    const events = await this.eventRepo.list(kindergartenId, {
      groupId,
      from: monday,
      to: nextMonday,
    });
    return { weekStart: monday, events };
  }

  /**
   * Per-day view used by staff `/staff/schedule/today`.
   */
  async getGroupToday(
    kindergartenId: string,
    groupId: string,
  ): Promise<ActivityEvent[]> {
    const now = this.clock.now();
    const dayStart = startOfUtcDay(now);
    const dayEnd = new Date(dayStart.getTime() + DAY_MS);
    return await this.eventRepo.list(kindergartenId, {
      groupId,
      from: dayStart,
      to: dayEnd,
    });
  }

  /**
   * Parent week view — resolves the child's current_group_id, then projects
   * activity_events of that group on the requested date range.
   *
   * The brief lists this as `getParentScheduleForChild`. Returns events
   * sorted by starts_at; controller maps to ScheduleWeekResponseDto if it
   * wants a grouped-by-day shape.
   */
  async getParentScheduleForChild(
    kindergartenId: string,
    childId: string,
    range: { from: Date; to: Date },
  ): Promise<ActivityEvent[]> {
    const child = await this.childRepo.findById(kindergartenId, childId);
    if (child === null) throw new ChildNotFoundError(childId);
    const groupId = child.toState().currentGroupId;
    if (groupId === null) {
      return [];
    }
    return await this.eventRepo.list(kindergartenId, {
      groupId,
      from: range.from,
      to: range.to,
    });
  }

  /**
   * Idempotent week-copy. For each non-archived group in the kindergarten:
   *   - if a snapshot already exists for `(kg, group, nextMonday)` → skip.
   *   - else: gather active templates valid on nextMonday, project each slot
   *     onto the corresponding date in the next week, bulk-insert events,
   *     write the snapshot.
   *
   * The `fromMonday` parameter names the *source* week (the week that has
   * just ended / is being rolled forward). The target week is `fromMonday +
   * 7 days`.
   */
  async copyWeekToNext(
    kindergartenId: string,
    fromMonday: Date,
    source: WeekSnapshotSource,
  ): Promise<CopyWeekResult> {
    const sourceMonday = startOfIsoWeek(fromMonday);
    const nextMonday = new Date(sourceMonday.getTime() + 7 * DAY_MS);

    const groups = await this.groupRepo.list(kindergartenId, {
      archived: false,
    });
    const templates = await this.templateRepo.listActiveValidOn(
      kindergartenId,
      nextMonday,
    );

    let copiedGroups = 0;
    let skippedGroups = 0;
    let totalEvents = 0;
    const snapshots: ScheduleWeekSnapshot[] = [];

    for (const group of groups) {
      // Cheap pre-check — common case is "snapshot already exists" and we
      // skip without bothering with template projection.
      const existing = await this.snapshotRepo.findByGroupAndWeek(
        kindergartenId,
        group.id,
        nextMonday,
      );
      if (existing !== null) {
        skippedGroups += 1;
        continue;
      }

      // Templates that apply to this group: kg-wide (groupId=null) + groupId-specific.
      const applicable = templates.filter(
        (t) => t.groupId === null || t.groupId === group.id,
      );

      const events: ActivityEvent[] = [];
      for (const template of applicable) {
        for (const slot of template.slots) {
          const isoDay = ISO_DAY_FOR_VALUE[slot.dayOfWeek];
          const eventDate = new Date(
            nextMonday.getTime() + (isoDay - 1) * DAY_MS,
          );
          const startsAt = combineDateAndTime(eventDate, slot.startTime);
          const endsAt = combineDateAndTime(eventDate, slot.endTime);
          events.push(
            ActivityEvent.createScheduled(
              {
                id: randomUUID(),
                kindergartenId,
                groupId: group.id,
                templateSlotId: slot.id,
                activityName: slot.activityName,
                locationId: slot.locationId,
                startsAt,
                endsAt,
                notes: null,
              },
              this.clock,
            ),
          );
        }
      }

      // Atomic claim on (group, week) BEFORE we touch activity_events. If
      // another caller raced us and wrote the snapshot in between, tryCreate
      // returns null and we move on without writing orphan events. If
      // tryCreate returns a saved row we now own this (group, week)
      // exclusively and can safely insert events.
      const snapshot = ScheduleWeekSnapshot.createNew(
        {
          id: randomUUID(),
          kindergartenId,
          groupId: group.id,
          weekStartDate: nextMonday,
          source,
          copiedFrom: null,
        },
        this.clock.now(),
      );
      const saved = await this.snapshotRepo.tryCreate(kindergartenId, snapshot);
      if (saved === null) {
        // Race: snapshot appeared between findByGroupAndWeek and tryCreate.
        // No events written, no TX poison.
        skippedGroups += 1;
        continue;
      }

      if (events.length > 0) {
        await this.eventRepo.createMany(kindergartenId, events);
      }
      snapshots.push(saved);
      copiedGroups += 1;
      totalEvents += events.length;
    }

    return { copiedGroups, skippedGroups, totalEvents, snapshots };
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  private async requireTemplate(
    kindergartenId: string,
    templateId: string,
  ): Promise<ScheduleTemplate> {
    const t = await this.templateRepo.findById(kindergartenId, templateId);
    if (t === null) throw new ScheduleTemplateNotFoundError(templateId);
    return t;
  }

  private async requireEvent(
    kindergartenId: string,
    eventId: string,
  ): Promise<ActivityEvent> {
    const e = await this.eventRepo.findById(kindergartenId, eventId);
    if (e === null) throw new ActivityEventNotFoundError(eventId);
    return e;
  }

  /**
   * Persist a state-machine transition with a conditional UPDATE so two
   * concurrent admin clicks (e.g. start + cancel on the same `scheduled`
   * event) cannot both win. The repo's `updateWithExpectedStatus` returns
   * `false` when 0 rows matched the (`id`, `kg`, `status = expectedOld`)
   * predicate — that means another request already moved the row to a
   * different status, so the current transition must be aborted with a 409.
   */
  private async persistTransition(
    kindergartenId: string,
    event: ActivityEvent,
    expectedOldStatus: ActivityEventStatusValue,
  ): Promise<ActivityEvent> {
    const ok = await this.eventRepo.updateWithExpectedStatus(
      kindergartenId,
      event,
      expectedOldStatus,
    );
    if (!ok) {
      throw new EventTransitionConflictError(
        event.id,
        expectedOldStatus,
        event.status.value,
      );
    }
    // Re-fetch to mirror the read-back behaviour of `update` and surface any
    // mapper-level normalisation back to the caller.
    const fresh = await this.eventRepo.findById(kindergartenId, event.id);
    if (fresh === null) {
      // Should not happen — we just observed affected=1 inside the same TX.
      throw new ActivityEventNotFoundError(event.id);
    }
    return fresh;
  }
}

// Reverse map: day_of_week enum value → ISO weekday number (Mon=1 … Sun=7).
const ISO_DAY_FOR_VALUE: Record<string, number> = {
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
  sun: 7,
};

function startOfUtcDay(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0),
  );
}

/**
 * Snap to the Monday of the ISO week containing `d`. Operates in UTC so the
 * cron and manual-trigger paths produce stable results regardless of the
 * server timezone.
 */
function startOfIsoWeek(d: Date): Date {
  const dayStart = startOfUtcDay(d);
  const isoDay = isoWeekdayOf(dayStart); // 1..7
  return new Date(dayStart.getTime() - (isoDay - 1) * DAY_MS);
}

/**
 * Build a UTC timestamp from a UTC date and a time string ("HH:MM" or
 * "HH:MM:SS"). The slot times are stored without timezone — we treat them
 * as UTC for the projection so the relative order of events is preserved.
 */
function combineDateAndTime(date: Date, time: string): Date {
  const [hh, mm, ss] = time.split(':');
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      parseInt(hh, 10),
      parseInt(mm, 10),
      ss ? parseInt(ss, 10) : 0,
      0,
    ),
  );
}
