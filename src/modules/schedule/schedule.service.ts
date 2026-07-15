import { Inject, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ChildNotFoundError } from '@/modules/child/domain/errors/child-not-found.error';
import { ChildRepository } from '@/modules/child/infrastructure/persistence/child.repository';
import { GroupNotFoundError } from '@/modules/group/domain/errors/group-not-found.error';
import { GroupRepository } from '@/modules/group/infrastructure/persistence/group.repository';
import { LocationRepository } from '@/modules/location/infrastructure/persistence/location.repository';
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
import {
  combineDateAndTimeInTimezone,
  isoWeekdayOf,
} from '@/shared-kernel/domain/value-objects/day-of-week.vo';
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
  category?: string | null;
  locationId?: string | null;
  description?: string | null;
}

export interface UpdateSlotPatch {
  dayOfWeek?: string;
  startTime?: string;
  endTime?: string;
  activityName?: string;
  category?: string;
  locationId?: string | null;
  description?: string | null;
}

export interface CreateAdHocEventInput {
  groupId: string;
  activityName: string;
  category?: string | null;
  locationId?: string | null;
  startsAt: Date;
  endsAt?: Date | null;
  notes?: string | null;
  createdByStaffId?: string | null;
}

export interface UpdateEventPatch {
  activityName?: string;
  category?: string;
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

export interface RematerializeResult {
  /** Distinct (group, week) pairs re-projected — one per snapshot in range. */
  rebuiltWeeks: number;
  /** Stale `origin='template'` scheduled future events removed. */
  deletedEvents: number;
  /** Fresh events written from the current template definitions. */
  insertedEvents: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Returns the trimmed value, or null when empty/whitespace-only/absent. */
function nonBlankOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

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
    // Optional so the existing service-unit wiring (which constructs
    // ScheduleService positionally without a location repo) keeps compiling.
    // `resolveLocationName(s)` fails closed → `location_name = null` when the
    // dep is undefined. Production wiring (`ScheduleModule.imports →
    // LocationModule`) always supplies the real adapter.
    @Optional()
    private readonly locationRepo?: LocationRepository,
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
    const saved = await this.templateRepo.save(kindergartenId, template);
    // `isActive` / `validUntil` change which templates apply to a week, and
    // `name` is cosmetic — but re-syncing unconditionally keeps one rule.
    await this.rematerializeFutureWeeks(kindergartenId, {
      groupId: saved.groupId,
    });
    return saved;
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
    // Read the groupId BEFORE the delete — afterwards the row is gone and we
    // would have nothing to scope the re-sync to.
    const template = await this.requireTemplate(kindergartenId, templateId);
    await this.templateRepo.delete(kindergartenId, templateId);
    // The projection now legitimately yields zero events from this template, so
    // its future events are swept. That is the intended outcome.
    await this.rematerializeFutureWeeks(kindergartenId, {
      groupId: template.groupId,
    });
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
      category: input.category ?? null,
      locationId: input.locationId ?? null,
      description: input.description ?? null,
    });
    const saved = await this.templateRepo.save(kindergartenId, template);
    await this.rematerializeFutureWeeks(kindergartenId, {
      groupId: saved.groupId,
    });
    return saved;
  }

  async updateSlot(
    kindergartenId: string,
    templateId: string,
    slotId: string,
    patch: UpdateSlotPatch,
  ): Promise<ScheduleTemplate> {
    const template = await this.requireTemplate(kindergartenId, templateId);
    template.updateSlot(slotId, patch);
    const saved = await this.templateRepo.save(kindergartenId, template);
    await this.rematerializeFutureWeeks(kindergartenId, {
      groupId: saved.groupId,
    });
    return saved;
  }

  async removeSlot(
    kindergartenId: string,
    templateId: string,
    slotId: string,
  ): Promise<ScheduleTemplate> {
    const template = await this.requireTemplate(kindergartenId, templateId);
    template.removeSlot(slotId);
    // Order matters: `save()` DELETEs the dropped slot row first, the FK
    // (ON DELETE SET NULL) NULLs `template_slot_id` on any already-materialized
    // event, and only THEN do we sweep — by `origin`, which the FK cannot erase.
    const saved = await this.templateRepo.save(kindergartenId, template);
    await this.rematerializeFutureWeeks(kindergartenId, {
      groupId: saved.groupId,
    });
    return saved;
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
        origin: 'adhoc',
        activityName: input.activityName,
        category: input.category ?? null,
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
                origin: 'template',
                activityName: slot.activityName,
                category: slot.category,
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

  /**
   * Re-project templates onto every week that has ALREADY been materialized and
   * is not yet over. This is the missing bridge between a template *definition*
   * and the materialized `activity_events` parents actually read.
   *
   * The problem it solves: `copyWeekToNext` is idempotent per (group, week) via
   * `schedule_week_snapshots`, so a week is materialized exactly ONCE. Every
   * later template edit was therefore invisible to parents — they stayed pinned
   * to whatever the template looked like at materialization time, forever. Worse,
   * `activity_events.template_slot_id` is ON DELETE SET NULL, so slots dropped by
   * a template edit left their already-materialized events behind as orphans with
   * stale names and a NULLed FK. `origin` (write-once, immutable) is what makes
   * those orphans reachable: they are still `origin='template'` even after the FK
   * is gone, which is exactly what distinguishes them from genuine ad-hoc events.
   *
   * @param opts.groupId narrows to a single group. `null`/omitted means every
   *   group — a kg-wide template (`groupId === null`) affects all of them.
   *
   * Window: weeks whose snapshot `week_start_date >= startOfIsoWeek(now)`. This
   * deliberately INCLUDES the current, in-flight week, and only ever touches
   * events with `starts_at > now`. That guard is the whole design — it rebuilds
   * the *remainder* of the current week while leaving everything already past
   * untouched, so an admin's edit today fixes the parents' view today instead of
   * in two weeks.
   *
   * Preserved by construction:
   *   - past weeks — no snapshot in range, never visited;
   *   - already started/finished/cancelled events — `status != 'scheduled'`;
   *   - events earlier today than `now` — `starts_at <= now`;
   *   - ad-hoc events — `origin = 'adhoc'`, never deleted and never recreated.
   *
   * This method never creates snapshots and never touches a week that has no
   * snapshot: the cron owns the forward materialization horizon, we only re-sync
   * weeks it already claimed. A template whose slots now project to nothing for a
   * group (e.g. after `deleteTemplate`) correctly ends up with zero events.
   *
   * Atomicity: like the rest of this service we do NOT open our own transaction —
   * the ambient per-request TX from `TenantContextInterceptor` (or, on the cron
   * path, the per-kg TX opened by `WeeklyRolloutService`) already wraps us, so the
   * delete+insert per week cannot be observed half-done and the repo's
   * `manager()` keeps every statement inside the transaction that issued
   * `SET LOCAL app.kindergarten_id` (RLS stays enforced).
   */
  async rematerializeFutureWeeks(
    kindergartenId: string,
    opts: { groupId?: string | null },
  ): Promise<RematerializeResult> {
    const now = this.clock.now();
    const currentWeekMonday = startOfIsoWeek(now);

    // `null` (kg-wide template) means "every group" → no groupId filter at all.
    const snapshots = await this.snapshotRepo.list(kindergartenId, {
      groupId: opts.groupId ?? undefined,
      from: currentWeekMonday,
    });

    let rebuiltWeeks = 0;
    let deletedEvents = 0;
    let insertedEvents = 0;

    // Templates depend only on the week, not the group — cache per week so N
    // groups sharing a week cost one `listActiveValidOn` instead of N.
    const templatesByWeek = new Map<number, ScheduleTemplate[]>();

    for (const snapshot of snapshots) {
      const weekStart = normalizeSnapshotWeekStart(snapshot.weekStartDate);
      // Sweep window is the UTC-anchored week, matching how copyWeekToNext
      // anchors the week it materializes. Caveat: since slot times are now
      // resolved in Asia/Almaty (UTC+5), a Monday slot authored before 05:00
      // local projects to the *previous* Sunday in UTC and therefore falls
      // outside this window — such an event would be re-inserted without its
      // stale copy being swept. Kindergarten slots are daytime (07:00–19:00
      // local), so this cannot trigger on real data; revisit the bound here if
      // pre-dawn slots ever become legitimate.
      const weekEnd = new Date(weekStart.getTime() + 7 * DAY_MS);

      let templates = templatesByWeek.get(weekStart.getTime());
      if (templates === undefined) {
        templates = await this.templateRepo.listActiveValidOn(
          kindergartenId,
          weekStart,
        );
        templatesByWeek.set(weekStart.getTime(), templates);
      }

      // Same applicability rule as copyWeekToNext: kg-wide + this group's own.
      const applicable = templates.filter(
        (t) => t.groupId === null || t.groupId === snapshot.groupId,
      );

      const events: ActivityEvent[] = [];
      for (const template of applicable) {
        for (const slot of template.slots) {
          const isoDay = ISO_DAY_FOR_VALUE[slot.dayOfWeek];
          const eventDate = new Date(
            weekStart.getTime() + (isoDay - 1) * DAY_MS,
          );
          const startsAt = combineDateAndTime(eventDate, slot.startTime);
          // Never re-create what the DELETE below deliberately spares.
          if (startsAt.getTime() <= now.getTime()) continue;
          events.push(
            ActivityEvent.createScheduled(
              {
                id: randomUUID(),
                kindergartenId,
                groupId: snapshot.groupId,
                templateSlotId: slot.id,
                origin: 'template',
                activityName: slot.activityName,
                category: slot.category,
                locationId: slot.locationId,
                startsAt,
                endsAt: combineDateAndTime(eventDate, slot.endTime),
                notes: null,
              },
              this.clock,
            ),
          );
        }
      }

      deletedEvents += await this.eventRepo.deleteTemplateScheduledInRange(
        kindergartenId,
        snapshot.groupId,
        weekStart,
        weekEnd,
        now,
      );
      if (events.length > 0) {
        await this.eventRepo.createMany(kindergartenId, events);
        insertedEvents += events.length;
      }
      rebuiltWeeks += 1;
    }

    return { rebuiltWeeks, deletedEvents, insertedEvents };
  }

  // ── identity overlay: location display name ─────────────────────────────

  /**
   * Resolves the display name of a single event's `location_id`. Returns null
   * when the event has no location, the location row is missing, or its name is
   * blank/whitespace-only (so the client can fall back cleanly). The lookup is
   * tenant-scoped via `LocationRepository.findById`. Fails closed — when the
   * optional `LocationRepository` is not wired, returns null.
   */
  async resolveLocationName(
    kindergartenId: string,
    event: ActivityEvent,
  ): Promise<string | null> {
    const locationId = event.locationId;
    if (locationId === null || !this.locationRepo) return null;
    const location = await this.locationRepo.findById(
      kindergartenId,
      locationId,
    );
    return nonBlankOrNull(location?.name);
  }

  /**
   * Batch variant for event lists — dedups `location_id`s (skipping the null
   * ones) so each distinct location is fetched once, then returns a map keyed
   * by `location_id`. Mirrors `ChildService.resolveGroupNames`. Events without
   * a location simply have no entry; the presenter falls back to null. Fails
   * closed: when the optional `LocationRepository` is not wired, returns an
   * empty map.
   */
  async resolveLocationNames(
    kindergartenId: string,
    events: ActivityEvent[],
  ): Promise<Map<string, string | null>> {
    const out = new Map<string, string | null>();
    if (!this.locationRepo) return out;
    const distinctLocationIds = [
      ...new Set(
        events
          .map((e) => e.locationId)
          .filter((id): id is string => id !== null && id !== undefined),
      ),
    ];
    for (const locationId of distinctLocationIds) {
      const location = await this.locationRepo.findById(
        kindergartenId,
        locationId,
      );
      out.set(locationId, nonBlankOrNull(location?.name));
    }
    return out;
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
  // Pass explicit 'UTC' — schedule cron operates in UTC for stability across
  // server timezones; the shared-kernel default (Asia/Almaty) applies only to
  // date-only kg-local calendar logic (e.g. parent-request day_off / vacation
  // validators).
  const isoDay = isoWeekdayOf(dayStart, 'UTC'); // 1..7
  return new Date(dayStart.getTime() - (isoDay - 1) * DAY_MS);
}

/**
 * Normalize a `schedule_week_snapshots.week_start_date` that was read back from
 * PG into the UTC-midnight instant of the Monday it names.
 *
 * Why this is not simply `startOfIsoWeek(d)`: `week_start_date` is a PG `date`,
 * and node-postgres parses a bare date into a *local-midnight* JS Date
 * (`new Date(y, m - 1, d)`). On a UTC server that already IS UTC midnight, but
 * on a server east of Greenwich — the dev box runs UTC+5 — '2026-05-04' comes
 * back as `2026-05-03T19:00:00Z`, i.e. a Sunday. `startOfIsoWeek` would then
 * snap it to the *previous* Monday and we would rebuild the wrong week.
 *
 * The stored value is always a Monday by construction (`copyWeekToNext` only
 * ever writes `nextMonday`), and every plausible parse of it lands within ±24h
 * of that Monday's UTC midnight. Snapping to the *nearest* Monday therefore
 * recovers the intended week under both the local-midnight and the UTC-midnight
 * reading, without depending on the process timezone.
 */
function normalizeSnapshotWeekStart(d: Date): Date {
  const mondayAtOrBefore = startOfIsoWeek(d);
  const followingMonday = new Date(mondayAtOrBefore.getTime() + 7 * DAY_MS);
  const distanceBack = d.getTime() - mondayAtOrBefore.getTime();
  const distanceForward = followingMonday.getTime() - d.getTime();
  return distanceBack <= distanceForward ? mondayAtOrBefore : followingMonday;
}

/**
 * Build the UTC instant for a slot's wall-clock `time` ("HH:MM" or "HH:MM:SS")
 * on the calendar day of `date`.
 *
 * `schedule_template_slots.start_time` / `end_time` are PG `time` columns — a
 * naive wall clock authored by the kindergarten, with no zone attached. They
 * are therefore interpreted in the kindergarten's timezone (Asia/Almaty, UTC+5,
 * no DST), NOT in UTC: a slot authored as 08:00 is 08:00 *local* → 03:00Z. The
 * previous `Date.UTC(...)` spelling declared the wall clock to *be* UTC, which
 * shifted every projected event +5h and made the apps render an 08:00 slot at
 * 13:00.
 *
 * Callers pass `date` as the UTC-midnight instant of the target day
 * (`nextMonday + (isoDay - 1) * DAY_MS`). At 00:00Z the Asia/Almaty calendar day
 * is already the same day (05:00 local), so the helper's "calendar day rendered
 * in the zone" semantics agree with the caller's intent.
 */
function combineDateAndTime(date: Date, time: string): Date {
  return combineDateAndTimeInTimezone(date, time);
}
