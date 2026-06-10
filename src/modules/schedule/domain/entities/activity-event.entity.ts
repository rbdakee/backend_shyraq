import { InvariantViolationError } from '@/shared-kernel/domain/errors';
import { InvalidEventTransitionError } from '../errors/invalid-event-transition.error';
import {
  ActivityEventStatus,
  ActivityEventStatusValue,
} from '../value-objects/activity-event-status.vo';
import {
  DEFAULT_SLOT_CATEGORY,
  isSlotCategory,
  SlotCategoryValue,
} from '../value-objects/slot-category.vo';

export interface Clock {
  now(): Date;
}

export interface ActivityEventState {
  id: string;
  kindergartenId: string;
  groupId: string;
  templateSlotId: string | null;
  activityName: string;
  /** Slot type for day-view colouring — copied from the slot at projection. */
  category: SlotCategoryValue;
  locationId: string | null;
  startsAt: Date;
  endsAt: Date | null;
  status: ActivityEventStatusValue;
  createdBy: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateActivityEventInput {
  id: string;
  kindergartenId: string;
  groupId: string;
  templateSlotId?: string | null;
  activityName: string;
  category?: string | null;
  locationId?: string | null;
  startsAt: Date;
  endsAt?: Date | null;
  createdBy?: string | null;
  notes?: string | null;
}

export interface UpdateActivityEventPatch {
  activityName?: string;
  category?: string;
  locationId?: string | null;
  startsAt?: Date;
  endsAt?: Date | null;
  notes?: string | null;
}

/**
 * Coerce an incoming category to a valid enum value. Undefined/null → server
 * default ('activity'); a non-empty unknown string throws (the DTO layer
 * rejects it as 400 first — this is defense-in-depth).
 */
function normalizeCategory(
  value: string | null | undefined,
): SlotCategoryValue {
  if (value === undefined || value === null) {
    return DEFAULT_SLOT_CATEGORY;
  }
  if (!isSlotCategory(value)) {
    throw new InvariantViolationError(`invalid slot category: ${value}`);
  }
  return value;
}

function validateRange(startsAt: Date, endsAt: Date | null): void {
  if (endsAt !== null && endsAt.getTime() <= startsAt.getTime()) {
    throw new InvariantViolationError(
      `activity_event ends_at must be > starts_at (${startsAt.toISOString()} → ${endsAt.toISOString()})`,
    );
  }
}

/**
 * ActivityEvent rich aggregate. State machine on the entity itself, side
 * effects (notification fan-out, group.current_location changes) live in the
 * service layer.
 *
 * Allowed transitions (B7 BP §9.3):
 *   scheduled    → in_progress | cancelled
 *   in_progress  → completed   | cancelled
 *   completed    → terminal
 *   cancelled    → terminal
 *
 * Cancel-reason is appended to `notes` (the migration does NOT carry a
 * dedicated `cancel_reason` column). If notes is non-null we prefix the
 * existing text with `[cancelled: ...] `.
 */
export class ActivityEvent {
  private constructor(
    readonly id: string,
    readonly kindergartenId: string,
    readonly groupId: string,
    private _templateSlotId: string | null,
    private _activityName: string,
    private _category: SlotCategoryValue,
    private _locationId: string | null,
    private _startsAt: Date,
    private _endsAt: Date | null,
    private _status: ActivityEventStatus,
    readonly createdBy: string | null,
    private _notes: string | null,
    readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static createScheduled(
    input: CreateActivityEventInput,
    clock: Clock,
  ): ActivityEvent {
    validateRange(input.startsAt, input.endsAt ?? null);
    const now = clock.now();
    return new ActivityEvent(
      input.id,
      input.kindergartenId,
      input.groupId,
      input.templateSlotId ?? null,
      input.activityName,
      normalizeCategory(input.category),
      input.locationId ?? null,
      input.startsAt,
      input.endsAt ?? null,
      ActivityEventStatus.SCHEDULED,
      input.createdBy ?? null,
      input.notes ?? null,
      now,
      now,
    );
  }

  static hydrate(state: ActivityEventState): ActivityEvent {
    return new ActivityEvent(
      state.id,
      state.kindergartenId,
      state.groupId,
      state.templateSlotId,
      state.activityName,
      state.category,
      state.locationId,
      state.startsAt,
      state.endsAt,
      ActivityEventStatus.from(state.status),
      state.createdBy,
      state.notes,
      state.createdAt,
      state.updatedAt,
    );
  }

  // ── getters ──────────────────────────────────────────────────────────────

  get templateSlotId(): string | null {
    return this._templateSlotId;
  }
  get activityName(): string {
    return this._activityName;
  }
  get category(): SlotCategoryValue {
    return this._category;
  }
  get locationId(): string | null {
    return this._locationId;
  }
  get startsAt(): Date {
    return this._startsAt;
  }
  get endsAt(): Date | null {
    return this._endsAt;
  }
  get status(): ActivityEventStatus {
    return this._status;
  }
  get notes(): string | null {
    return this._notes;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }

  // ── state machine ────────────────────────────────────────────────────────

  start(clock: Clock): void {
    if (!this._status.canTransitionTo(ActivityEventStatus.IN_PROGRESS)) {
      throw new InvalidEventTransitionError(this._status.value, 'in_progress');
    }
    this._status = ActivityEventStatus.IN_PROGRESS;
    this._updatedAt = clock.now();
  }

  complete(clock: Clock): void {
    if (!this._status.canTransitionTo(ActivityEventStatus.COMPLETED)) {
      throw new InvalidEventTransitionError(this._status.value, 'completed');
    }
    this._status = ActivityEventStatus.COMPLETED;
    this._updatedAt = clock.now();
  }

  cancel(reason: string, clock: Clock): void {
    if (!this._status.canTransitionTo(ActivityEventStatus.CANCELLED)) {
      throw new InvalidEventTransitionError(this._status.value, 'cancelled');
    }
    this._status = ActivityEventStatus.CANCELLED;
    const trimmed = reason.trim();
    if (trimmed.length > 0) {
      const prefix = `[cancelled: ${trimmed}]`;
      this._notes =
        this._notes === null || this._notes.length === 0
          ? prefix
          : `${prefix} ${this._notes}`;
    }
    this._updatedAt = clock.now();
  }

  // ── admin update (only valid in scheduled status) ───────────────────────

  reschedule(patch: UpdateActivityEventPatch, clock: Clock): void {
    if (!this._status.equals(ActivityEventStatus.SCHEDULED)) {
      throw new InvalidEventTransitionError(
        this._status.value,
        this._status.value,
      );
    }
    const nextStart =
      patch.startsAt !== undefined ? patch.startsAt : this._startsAt;
    const nextEnd = patch.endsAt !== undefined ? patch.endsAt : this._endsAt;
    validateRange(nextStart, nextEnd);
    if (patch.activityName !== undefined) {
      this._activityName = patch.activityName;
    }
    if (patch.category !== undefined) {
      this._category = normalizeCategory(patch.category);
    }
    if (patch.locationId !== undefined) {
      this._locationId = patch.locationId;
    }
    if (patch.startsAt !== undefined) {
      this._startsAt = patch.startsAt;
    }
    if (patch.endsAt !== undefined) {
      this._endsAt = patch.endsAt;
    }
    if (patch.notes !== undefined) {
      this._notes = patch.notes;
    }
    this._updatedAt = clock.now();
  }

  toState(): ActivityEventState {
    return {
      id: this.id,
      kindergartenId: this.kindergartenId,
      groupId: this.groupId,
      templateSlotId: this._templateSlotId,
      activityName: this._activityName,
      category: this._category,
      locationId: this._locationId,
      startsAt: this._startsAt,
      endsAt: this._endsAt,
      status: this._status.value,
      createdBy: this.createdBy,
      notes: this._notes,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
    };
  }
}
