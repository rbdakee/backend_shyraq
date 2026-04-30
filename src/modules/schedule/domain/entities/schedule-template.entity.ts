import { SlotConflictError } from '../errors/slot-conflict.error';
import { SlotNotFoundError } from '../errors/slot-not-found.error';
import {
  ScheduleTemplateSlot,
  ScheduleTemplateSlotState,
} from './schedule-template-slot.entity';

export interface Clock {
  now(): Date;
}

export interface ScheduleTemplateState {
  id: string;
  kindergartenId: string;
  groupId: string | null;
  name: string;
  recurrence: string;
  isActive: boolean;
  validFrom: Date;
  validUntil: Date | null;
  createdAt: Date;
  /** Slots may not always be eagerly loaded — repository decides. */
  slots: ScheduleTemplateSlotState[];
}

export interface CreateScheduleTemplateInput {
  id: string;
  kindergartenId: string;
  groupId?: string | null;
  name: string;
  recurrence?: string;
  validFrom: Date;
  validUntil?: Date | null;
}

export interface UpdateScheduleTemplatePatch {
  name?: string;
  isActive?: boolean;
  validUntil?: Date | null;
}

export interface AddSlotInput {
  id: string;
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

/**
 * ScheduleTemplate — rich aggregate. Owns the `(template_id, day_of_week,
 * start_time)` partial-unique invariant on its slots: addSlot/updateSlot
 * detect conflicts before persistence so the API gets a clear domain error
 * instead of a raw PG 23505. The DB constraint stays as defense-in-depth.
 *
 * State-export pattern matches Group/Enrollment: rich aggregate keeps
 * private fields, exposes getters, builds a flat `state` for the mapper.
 */
export class ScheduleTemplate {
  private _slots: ScheduleTemplateSlot[];

  private constructor(
    readonly id: string,
    readonly kindergartenId: string,
    private _groupId: string | null,
    private _name: string,
    private _recurrence: string,
    private _isActive: boolean,
    private _validFrom: Date,
    private _validUntil: Date | null,
    readonly createdAt: Date,
    slots: ScheduleTemplateSlot[],
  ) {
    this._slots = slots;
  }

  static createNew(
    input: CreateScheduleTemplateInput,
    clock: Clock,
  ): ScheduleTemplate {
    const now = clock.now();
    return new ScheduleTemplate(
      input.id,
      input.kindergartenId,
      input.groupId ?? null,
      input.name,
      input.recurrence ?? 'weekly',
      true,
      input.validFrom,
      input.validUntil ?? null,
      now,
      [],
    );
  }

  static hydrate(state: ScheduleTemplateState): ScheduleTemplate {
    const slots = state.slots.map((s) => ScheduleTemplateSlot.hydrate(s));
    return new ScheduleTemplate(
      state.id,
      state.kindergartenId,
      state.groupId,
      state.name,
      state.recurrence,
      state.isActive,
      state.validFrom,
      state.validUntil,
      state.createdAt,
      slots,
    );
  }

  // ── getters ──────────────────────────────────────────────────────────────

  get groupId(): string | null {
    return this._groupId;
  }
  get name(): string {
    return this._name;
  }
  get recurrence(): string {
    return this._recurrence;
  }
  get isActive(): boolean {
    return this._isActive;
  }
  get validFrom(): Date {
    return this._validFrom;
  }
  get validUntil(): Date | null {
    return this._validUntil;
  }
  /** Read-only view of slots in canonical (day, startTime) order. */
  get slots(): readonly ScheduleTemplateSlot[] {
    return this.sortedSlots();
  }

  private sortedSlots(): ScheduleTemplateSlot[] {
    return [...this._slots].sort((a, b) => {
      const dayOrder: Record<string, number> = {
        mon: 0,
        tue: 1,
        wed: 2,
        thu: 3,
        fri: 4,
        sat: 5,
        sun: 6,
      };
      const da = dayOrder[a.dayOfWeek];
      const db = dayOrder[b.dayOfWeek];
      if (da !== db) return da - db;
      return a.startTime < b.startTime ? -1 : a.startTime > b.startTime ? 1 : 0;
    });
  }

  // ── template-level mutators ──────────────────────────────────────────────

  update(patch: UpdateScheduleTemplatePatch): void {
    if (patch.name !== undefined) {
      this._name = patch.name;
    }
    if (patch.isActive !== undefined) {
      this._isActive = patch.isActive;
    }
    if (patch.validUntil !== undefined) {
      this._validUntil = patch.validUntil;
    }
  }

  activate(): void {
    this._isActive = true;
  }

  deactivate(): void {
    this._isActive = false;
  }

  // ── slot mutators (with invariants) ──────────────────────────────────────

  addSlot(input: AddSlotInput): ScheduleTemplateSlot {
    const slot = ScheduleTemplateSlot.create({
      id: input.id,
      templateId: this.id,
      dayOfWeek: input.dayOfWeek,
      startTime: input.startTime,
      endTime: input.endTime,
      activityName: input.activityName,
      locationId: input.locationId ?? null,
      description: input.description ?? null,
    });

    const conflict = this._slots.find(
      (s) => s.dayOfWeek === slot.dayOfWeek && s.startTime === slot.startTime,
    );
    if (conflict !== undefined) {
      throw new SlotConflictError(this.id, slot.dayOfWeek, slot.startTime);
    }

    this._slots.push(slot);
    return slot;
  }

  updateSlot(slotId: string, patch: UpdateSlotPatch): ScheduleTemplateSlot {
    const slot = this._slots.find((s) => s.id === slotId);
    if (slot === undefined) {
      throw new SlotNotFoundError(slotId);
    }

    // Apply patch on a copy so we can detect conflicts before mutating in place.
    const candidateState = slot.toState();
    if (patch.dayOfWeek !== undefined)
      candidateState.dayOfWeek = patch.dayOfWeek as never;
    if (patch.startTime !== undefined) {
      candidateState.startTime = patch.startTime;
    }
    const probeDay = patch.dayOfWeek ?? slot.dayOfWeek;
    const probeStart =
      patch.startTime !== undefined
        ? // normalize via slot's own validation — but we just need a quick lex compare here
          patch.startTime.length === 5
          ? `${patch.startTime}:00`
          : patch.startTime
        : slot.startTime;
    const conflict = this._slots.find(
      (s) =>
        s.id !== slotId &&
        s.dayOfWeek === probeDay &&
        s.startTime === probeStart,
    );
    if (conflict !== undefined) {
      throw new SlotConflictError(this.id, probeDay, probeStart);
    }

    slot.patch(patch);
    return slot;
  }

  removeSlot(slotId: string): void {
    const idx = this._slots.findIndex((s) => s.id === slotId);
    if (idx < 0) {
      throw new SlotNotFoundError(slotId);
    }
    this._slots.splice(idx, 1);
  }

  // ── state export ────────────────────────────────────────────────────────

  toState(): ScheduleTemplateState {
    return {
      id: this.id,
      kindergartenId: this.kindergartenId,
      groupId: this._groupId,
      name: this._name,
      recurrence: this._recurrence,
      isActive: this._isActive,
      validFrom: this._validFrom,
      validUntil: this._validUntil,
      createdAt: this.createdAt,
      slots: this.sortedSlots().map((s) => s.toState()),
    };
  }
}
