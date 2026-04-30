import {
  ChildIntradayStatus,
  ChildIntradayStatusValue,
} from '../value-objects/child-intraday-status.vo';

export interface Clock {
  now(): Date;
}

export interface ChildDailyStatusState {
  id: string;
  kindergartenId: string;
  childId: string;
  /** ISO date string (YYYY-MM-DD), no timezone — tied to the kindergarten's local day. */
  date: string;
  status: ChildIntradayStatusValue;
  note: string | null;
  setBy: string | null;
  updatedAt: Date;
}

export interface CreateChildDailyStatusInput {
  id: string;
  kindergartenId: string;
  childId: string;
  date: string;
  status: ChildIntradayStatus;
  note?: string | null;
  setBy: string | null;
}

/**
 * ChildDailyStatus — rich aggregate for the per-(child, day) status row.
 *
 * Created by the first relevant signal of the day:
 *   - parent reports an absence/sickness/vacation → `status` set explicitly,
 *     `setBy` = staff who recorded it (or null for a parent-driven write).
 *   - staff manual setDailyStatus → `status` = chosen value.
 *   - staff check-in:
 *       * if no row → INSERT with status=present.
 *       * if row exists with status in {absent, late} → UPDATE to present.
 *       * else → leave alone (idempotent, preserves operator's prior call).
 *
 * The promotion rule is enforced via `markPresent(by, at)` which delegates to
 * `ChildIntradayStatus.isPromotableByCheckIn()`. The service treats
 * `markPresent` returning false as "leave the row alone" — no error, no-op.
 */
export class ChildDailyStatus {
  private constructor(
    readonly id: string,
    readonly kindergartenId: string,
    readonly childId: string,
    readonly date: string,
    private _status: ChildIntradayStatus,
    private _note: string | null,
    private _setBy: string | null,
    private _updatedAt: Date,
  ) {}

  static createNew(
    input: CreateChildDailyStatusInput,
    clock: Clock,
  ): ChildDailyStatus {
    return new ChildDailyStatus(
      input.id,
      input.kindergartenId,
      input.childId,
      input.date,
      input.status,
      input.note ?? null,
      input.setBy,
      clock.now(),
    );
  }

  static hydrate(state: ChildDailyStatusState): ChildDailyStatus {
    return new ChildDailyStatus(
      state.id,
      state.kindergartenId,
      state.childId,
      state.date,
      ChildIntradayStatus.from(state.status),
      state.note,
      state.setBy,
      state.updatedAt,
    );
  }

  // ── getters ──────────────────────────────────────────────────────────────

  get status(): ChildIntradayStatus {
    return this._status;
  }

  get note(): string | null {
    return this._note;
  }

  get setBy(): string | null {
    return this._setBy;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /**
   * Attempt to promote this row to `present` from a check-in event. Returns
   * `true` when the status flipped (write needed) and `false` when the row
   * was preserved as-is (no write needed).
   *
   * Only `absent` and `late` are promotable; everything else (`present`,
   * `sick`, `early_pickup`, `on_vacation`) is preserved.
   */
  markPresent(by: string | null, clock: Clock): boolean {
    if (!this._status.isPromotableByCheckIn()) {
      return false;
    }
    this._status = ChildIntradayStatus.PRESENT;
    this._setBy = by;
    this._updatedAt = clock.now();
    return true;
  }

  /**
   * Explicit operator decision via `setDailyStatus` — overwrites status,
   * note, set_by unconditionally. The repo upsert path constructs a fresh
   * row on insert; this method is for the in-memory representation when an
   * existing row is being updated.
   */
  setStatus(
    status: ChildIntradayStatus,
    note: string | null,
    by: string | null,
    clock: Clock,
  ): void {
    this._status = status;
    this._note = note;
    this._setBy = by;
    this._updatedAt = clock.now();
  }

  toState(): ChildDailyStatusState {
    return {
      id: this.id,
      kindergartenId: this.kindergartenId,
      childId: this.childId,
      date: this.date,
      status: this._status.value,
      note: this._note,
      setBy: this._setBy,
      updatedAt: this._updatedAt,
    };
  }
}
