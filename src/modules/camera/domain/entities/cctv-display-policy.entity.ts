import { InvariantViolationError } from '@/shared-kernel/domain/errors';
import {
  combineDateAndTimeInTimezone,
  isoWeekdayOf,
  KG_DEFAULT_TIMEZONE,
} from '@/shared-kernel/domain/value-objects/day-of-week.vo';
import {
  CctvDisplayMode,
  isCctvDisplayMode,
} from '../value-objects/cctv-display-mode.vo';

/** One half of the day: what to show, and which cameras that mode uses. */
export interface CctvDisplaySlot {
  mode: CctvDisplayMode;
  /**
   * In `cameras` mode — the whole answer. In `schedule` mode — the fallback
   * used when the group's own chain points nowhere. Ignored in `off` mode.
   * Order is the order the app renders.
   */
  cameraIds: string[];
}

/** Which half of the day `now` fell into, plus that half's slot. */
export interface CctvDisplayDecision extends CctvDisplaySlot {
  phase: 'work_hours' | 'off_hours';
}

export interface CctvDisplayPolicyState {
  kindergartenId: string;
  /** ISO weekdays the kindergarten works: 1=Mon … 7=Sun. May be empty. */
  workDays: number[];
  /** Wall clock in kindergarten-local time, `HH:MM`. */
  opensAt: string;
  closesAt: string;
  workHours: CctvDisplaySlot;
  offHours: CctvDisplaySlot;
  createdAt: Date;
  updatedAt: Date;
}

const WALL_CLOCK_RE = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Error codes this entity raises. `InvariantViolationError` carries the code
 * straight to the HTTP body, so these are contract: the admin panel maps them
 * to messages. Slugs, never sentences.
 */
export const CCTV_POLICY_TIME_INVALID = 'cctv_policy_time_invalid';
export const CCTV_POLICY_WINDOW_INVALID = 'cctv_policy_window_invalid';
export const CCTV_POLICY_WORK_DAY_INVALID = 'cctv_policy_work_day_invalid';
export const CCTV_POLICY_MODE_INVALID = 'cctv_policy_mode_invalid';

/** `'19:00:00'` (PG `time`) and `'19:00'` (admin UI) both land on `'19:00'`. */
function normalizeWallClock(value: string): string {
  const match = WALL_CLOCK_RE.exec(value);
  if (!match) throw new InvariantViolationError(CCTV_POLICY_TIME_INVALID);
  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  if (hours > 23 || minutes > 59) {
    throw new InvariantViolationError(CCTV_POLICY_TIME_INVALID);
  }
  return `${match[1]}:${match[2]}`;
}

function normalizeWorkDays(days: number[]): number[] {
  for (const day of days) {
    if (!Number.isInteger(day) || day < 1 || day > 7) {
      throw new InvariantViolationError(CCTV_POLICY_WORK_DAY_INVALID);
    }
  }
  return [...new Set(days)].sort((a, b) => a - b);
}

function normalizeSlot(slot: CctvDisplaySlot): CctvDisplaySlot {
  if (!isCctvDisplayMode(slot.mode)) {
    throw new InvariantViolationError(CCTV_POLICY_MODE_INVALID);
  }
  // Duplicates would render the same camera twice in the app; first position
  // wins so the admin's ordering survives.
  return { mode: slot.mode, cameraIds: [...new Set(slot.cameraIds)] };
}

/**
 * CctvDisplayPolicy — the kindergarten's answer to "what do parents see, and
 * when", read on every parent CCTV request.
 *
 * The day is split by a working-hours window (`workDays` + `opensAt`/
 * `closesAt`, in kindergarten-local time) into two independently configured
 * slots. Outside the window — evenings, weekends — a kindergarten typically
 * either points everyone at the entrance cameras or shows nothing at all,
 * which is exactly what `offHours` expresses.
 *
 * `default()` reproduces the behaviour that predates this entity: follow the
 * schedule all day, every day, with no fallback list. A kindergarten that
 * never opens the settings screen has no row and gets that.
 */
export class CctvDisplayPolicy {
  private constructor(
    readonly kindergartenId: string,
    private _workDays: number[],
    private _opensAt: string,
    private _closesAt: string,
    private _workHours: CctvDisplaySlot,
    private _offHours: CctvDisplaySlot,
    readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static hydrate(state: CctvDisplayPolicyState): CctvDisplayPolicy {
    const opensAt = normalizeWallClock(state.opensAt);
    const closesAt = normalizeWallClock(state.closesAt);
    // An inverted or empty window would make "work hours" unreadable — is
    // 20:00 inside 19:00–07:00? The DB CHECK says the same thing; this keeps
    // the rule in the domain too, where the admin's patch is validated.
    if (opensAt >= closesAt) {
      throw new InvariantViolationError(CCTV_POLICY_WINDOW_INVALID);
    }
    return new CctvDisplayPolicy(
      state.kindergartenId,
      normalizeWorkDays(state.workDays),
      opensAt,
      closesAt,
      normalizeSlot(state.workHours),
      normalizeSlot(state.offHours),
      state.createdAt,
      state.updatedAt,
    );
  }

  /**
   * The policy a kindergarten has until someone saves one: follow the schedule
   * around the clock, no fallback cameras. Mon–Fri 07:00–19:00 is only the
   * window the admin screen starts from — with both slots on `schedule` it
   * changes nothing on its own.
   */
  static default(kindergartenId: string, now: Date): CctvDisplayPolicy {
    return CctvDisplayPolicy.hydrate({
      kindergartenId,
      workDays: [1, 2, 3, 4, 5],
      opensAt: '07:00',
      closesAt: '19:00',
      workHours: { mode: 'schedule', cameraIds: [] },
      offHours: { mode: 'schedule', cameraIds: [] },
      createdAt: now,
      updatedAt: now,
    });
  }

  get workDays(): number[] {
    return [...this._workDays];
  }
  get opensAt(): string {
    return this._opensAt;
  }
  get closesAt(): string {
    return this._closesAt;
  }
  get workHours(): CctvDisplaySlot {
    return {
      mode: this._workHours.mode,
      cameraIds: [...this._workHours.cameraIds],
    };
  }
  get offHours(): CctvDisplaySlot {
    return {
      mode: this._offHours.mode,
      cameraIds: [...this._offHours.cameraIds],
    };
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** Every camera the policy can name, deduplicated — the write-side check. */
  get referencedCameraIds(): string[] {
    return [
      ...new Set([...this._workHours.cameraIds, ...this._offHours.cameraIds]),
    ];
  }

  /**
   * True when `instant` falls on a working day, inside the open window, in the
   * kindergarten's local time. The zone matters: 19:30 Almaty is 14:30Z, and
   * comparing UTC wall clocks would call the evening a working hour.
   */
  isWithinWorkHours(
    instant: Date,
    timeZone: string = KG_DEFAULT_TIMEZONE,
  ): boolean {
    if (!this._workDays.includes(isoWeekdayOf(instant, timeZone))) return false;
    const opens = combineDateAndTimeInTimezone(
      instant,
      this._opensAt,
      timeZone,
    );
    const closes = combineDateAndTimeInTimezone(
      instant,
      this._closesAt,
      timeZone,
    );
    return instant >= opens && instant < closes;
  }

  /** Which slot governs `instant`. */
  decideAt(
    instant: Date,
    timeZone: string = KG_DEFAULT_TIMEZONE,
  ): CctvDisplayDecision {
    return this.isWithinWorkHours(instant, timeZone)
      ? { phase: 'work_hours', ...this.workHours }
      : { phase: 'off_hours', ...this.offHours };
  }

  toState(): CctvDisplayPolicyState {
    return {
      kindergartenId: this.kindergartenId,
      workDays: this.workDays,
      opensAt: this._opensAt,
      closesAt: this._closesAt,
      workHours: this.workHours,
      offHours: this.offHours,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
    };
  }
}
