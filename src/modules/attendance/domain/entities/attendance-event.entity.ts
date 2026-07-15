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
  deletedAt: Date | null;
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
  /**
   * Null only in the B11 OTP-pickup branch where the picker is a non-user
   * trusted person known just by their phone snapshot on the
   * pickup_request. The legacy staff-driven branch always passes a
   * non-null userId (the picking-up guardian).
   */
  pickupUserId: string | null;
  pickupRequestId?: string | null;
}

export interface UpdateAttendanceEventPatch {
  recordedAt?: Date;
  notes?: string | null;
  pickupUserId?: string | null;
  /**
   * Admin-only correction: re-point the row at a different child (a record
   * filed against the wrong kid). The service is responsible for the
   * cascade — moving the paired timeline entry and recomputing
   * `child_daily_status` for BOTH the old and the new child.
   */
  childId?: string;
  /**
   * Admin-only correction: flip check_in ⇄ check_out (a mis-pressed button).
   * Flipping to `check_in` clears pickup_user_id / pickup_request_id — see
   * `applyPatch`.
   */
  eventType?: AttendanceEventType;
}

/**
 * AttendanceEvent — check-in / check-out log row.
 *
 * The aggregate is intentionally lean: the row is immutable except via the
 * controlled `applyPatch` path and `softDelete`.
 *
 * Mutability rules:
 *   - reception/admin may patch recorded_at, notes, pickup_user_id;
 *   - ADMIN ONLY may additionally patch child_id and event_type, to correct a
 *     record filed against the wrong child or with the wrong direction. The
 *     service gates this on `isAdmin` and owns the resulting cascade;
 *   - `method` is immutable — it records HOW the row came to exist (manual /
 *     face_id / otp_pickup), which no correction can retroactively change.
 *
 * Audit semantics: child_id / event_type used to be immutable so that history
 * could be inferred from the row itself. That guarantee now lives in the
 * `audit_log` table, which captures actor + before/after for every mutation —
 * so the fields are editable while the history is still recoverable. Do not
 * re-freeze them without first checking that audit_log is still written on
 * every path.
 *
 * Deletion is soft (`deleted_at`): the DB row survives so audit_log's
 * entity_id keeps resolving. Every read path MUST filter `deleted_at IS NULL`
 * — a missed filter surfaces deleted events in the dashboard counters.
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
    private _childId: string,
    private _eventType: AttendanceEventType,
    readonly method: AttendanceMethod,
    readonly recordedBy: string | null,
    private _pickupUserId: string | null,
    private _pickupRequestId: string | null,
    private _notes: string | null,
    private _recordedAt: Date,
    readonly createdAt: Date,
    private _deletedAt: Date | null,
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
      null,
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
      null,
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
      state.deletedAt,
    );
  }

  // ── getters ──────────────────────────────────────────────────────────────

  get childId(): string {
    return this._childId;
  }

  get eventType(): AttendanceEventType {
    return this._eventType;
  }

  get deletedAt(): Date | null {
    return this._deletedAt;
  }

  get isDeleted(): boolean {
    return this._deletedAt !== null;
  }

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
   * Reception/admin patch over recorded_at, notes, pickup_user_id, plus the
   * admin-only child_id / event_type corrections.
   *
   * Service layer remains responsible for:
   *   - the edit-window check (non-admin: same calendar day),
   *   - gating child_id / event_type on `isAdmin`,
   *   - re-validating a changed pickup user against the guardian table,
   *   - the child_id / event_type cascade (timeline re-point, daily_status
   *     recompute for both children),
   *   - writing the audit_log row.
   *
   * The one invariant enforced HERE: a `check_in` row can never carry a
   * pickup user. Flipping event_type to check_in therefore clears
   * pickup_user_id and pickup_request_id rather than leaving the row in a
   * shape the check-out validation would reject. The cleared values are
   * recoverable from audit_log's `before` snapshot.
   *
   * Calling `applyPatch` with `pickupUserId` on a row that stays a check_in
   * is still rejected at the service boundary (clearer error for the caller).
   */
  applyPatch(patch: UpdateAttendanceEventPatch): void {
    if (patch.recordedAt !== undefined) {
      this._recordedAt = patch.recordedAt;
    }
    if (patch.notes !== undefined) {
      this._notes = patch.notes;
    }
    if (patch.childId !== undefined) {
      this._childId = patch.childId;
    }
    if (patch.eventType !== undefined) {
      this._eventType = patch.eventType;
    }
    if (patch.pickupUserId !== undefined) {
      this._pickupUserId = patch.pickupUserId;
    }
    if (this._eventType.value === 'check_in') {
      this._pickupUserId = null;
      this._pickupRequestId = null;
    }
  }

  /**
   * Soft-delete. Idempotent: re-deleting an already-deleted row keeps the
   * original timestamp, so audit_log's first `delete` entry stays the
   * authoritative one.
   */
  softDelete(at: Date): void {
    if (this._deletedAt === null) {
      this._deletedAt = at;
    }
  }

  toState(): AttendanceEventState {
    return {
      id: this.id,
      kindergartenId: this.kindergartenId,
      childId: this._childId,
      eventType: this._eventType.value,
      method: this.method.value,
      recordedBy: this.recordedBy,
      pickupUserId: this._pickupUserId,
      pickupRequestId: this._pickupRequestId,
      notes: this._notes,
      recordedAt: this._recordedAt,
      createdAt: this.createdAt,
      deletedAt: this._deletedAt,
    };
  }
}
