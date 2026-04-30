import {
  AttendanceEventType,
  AttendanceEventTypeValue,
} from '../value-objects/attendance-event-type.vo';
import {
  AttendanceMethod,
  AttendanceMethodValue,
} from '../value-objects/attendance-method.vo';

export interface Clock {
  now(): Date;
}

export interface AttendanceEventState {
  id: string;
  kindergartenId: string;
  childId: string;
  eventType: AttendanceEventTypeValue;
  method: AttendanceMethodValue;
  recordedBy: string | null;
  pickupUserId: string | null;
  pickupRequestId: string | null;
  notes: string | null;
  recordedAt: Date;
  createdAt: Date;
}

export interface CreateAttendanceEventInput {
  id: string;
  kindergartenId: string;
  childId: string;
  method: AttendanceMethod;
  recordedBy: string | null;
  notes?: string | null;
  recordedAt: Date;
}

export interface CreateCheckOutInput extends CreateAttendanceEventInput {
  pickupUserId: string;
  pickupRequestId?: string | null;
}

export interface UpdateAttendanceEventPatch {
  recordedAt?: Date;
  notes?: string | null;
  pickupUserId?: string | null;
}

/**
 * AttendanceEvent — append-only check-in / check-out log row.
 *
 * The aggregate is intentionally lean: the row is immutable except via the
 * controlled `applyPatch` path, which allows reception/admin to fix mistakes
 * (recorded_at, notes, pickup_user_id). Type and method cannot change after
 * creation — this preserves audit semantics on top of the append-only DB
 * shape.
 *
 * Construction:
 *   - `createCheckIn` — pickup_user_id stays null.
 *   - `createCheckOut` — pickup_user_id is required (the picking-up
 *     guardian/user). `recorded_by` is the staff member who pressed the
 *     button.
 *
 * The B8 staff path always sets `method=manual`. Future phases (face-id
 * terminal in B11) can call `createCheckIn(method=AttendanceMethod.FACE_ID)`
 * etc., so the constructor accepts a `method` argument rather than hard-coding.
 */
export class AttendanceEvent {
  private constructor(
    readonly id: string,
    readonly kindergartenId: string,
    readonly childId: string,
    readonly eventType: AttendanceEventType,
    readonly method: AttendanceMethod,
    readonly recordedBy: string | null,
    private _pickupUserId: string | null,
    private _pickupRequestId: string | null,
    private _notes: string | null,
    private _recordedAt: Date,
    readonly createdAt: Date,
  ) {}

  static createCheckIn(
    input: CreateAttendanceEventInput,
    clock: Clock,
  ): AttendanceEvent {
    const now = clock.now();
    return new AttendanceEvent(
      input.id,
      input.kindergartenId,
      input.childId,
      AttendanceEventType.CHECK_IN,
      input.method,
      input.recordedBy,
      null,
      null,
      input.notes ?? null,
      input.recordedAt,
      now,
    );
  }

  static createCheckOut(
    input: CreateCheckOutInput,
    clock: Clock,
  ): AttendanceEvent {
    const now = clock.now();
    return new AttendanceEvent(
      input.id,
      input.kindergartenId,
      input.childId,
      AttendanceEventType.CHECK_OUT,
      input.method,
      input.recordedBy,
      input.pickupUserId,
      input.pickupRequestId ?? null,
      input.notes ?? null,
      input.recordedAt,
      now,
    );
  }

  static hydrate(state: AttendanceEventState): AttendanceEvent {
    return new AttendanceEvent(
      state.id,
      state.kindergartenId,
      state.childId,
      AttendanceEventType.from(state.eventType),
      AttendanceMethod.from(state.method),
      state.recordedBy,
      state.pickupUserId,
      state.pickupRequestId,
      state.notes,
      state.recordedAt,
      state.createdAt,
    );
  }

  // ── getters ──────────────────────────────────────────────────────────────

  get pickupUserId(): string | null {
    return this._pickupUserId;
  }

  get pickupRequestId(): string | null {
    return this._pickupRequestId;
  }

  get notes(): string | null {
    return this._notes;
  }

  get recordedAt(): Date {
    return this._recordedAt;
  }

  /**
   * Reception/admin patch. Only recorded_at, notes, pickup_user_id are
   * mutable. Service layer is responsible for the edit-window check
   * (non-admin: same calendar day) and for re-validating the new pickup
   * user against the guardian table when it changes.
   *
   * Calling `applyPatch` on a check-in event with `pickupUserId !== undefined`
   * is rejected at the service boundary (a check-in has no pickup user) — the
   * entity itself does not enforce that to keep the patching surface narrow;
   * service.ts gates that case.
   */
  applyPatch(patch: UpdateAttendanceEventPatch): void {
    if (patch.recordedAt !== undefined) {
      this._recordedAt = patch.recordedAt;
    }
    if (patch.notes !== undefined) {
      this._notes = patch.notes;
    }
    if (patch.pickupUserId !== undefined) {
      this._pickupUserId = patch.pickupUserId;
    }
  }

  toState(): AttendanceEventState {
    return {
      id: this.id,
      kindergartenId: this.kindergartenId,
      childId: this.childId,
      eventType: this.eventType.value,
      method: this.method.value,
      recordedBy: this.recordedBy,
      pickupUserId: this._pickupUserId,
      pickupRequestId: this._pickupRequestId,
      notes: this._notes,
      recordedAt: this._recordedAt,
      createdAt: this.createdAt,
    };
  }
}
