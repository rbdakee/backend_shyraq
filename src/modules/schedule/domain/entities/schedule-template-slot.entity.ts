import { InvalidSlotTimeError } from '../errors/invalid-slot-time.error';
import {
  DayOfWeekValue,
  isDayOfWeek,
} from '@/shared-kernel/domain/value-objects/day-of-week.vo';

/**
 * Plain TS view of a `schedule_template_slots` row. POJO — no TypeORM imports.
 */
export interface ScheduleTemplateSlotState {
  id: string;
  templateId: string;
  dayOfWeek: DayOfWeekValue;
  /** 24-hour HH:MM:SS (or HH:MM). DB column is `time` — we keep ISO-string view. */
  startTime: string;
  endTime: string;
  activityName: string;
  locationId: string | null;
  description: string | null;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;

function normalizeTime(t: string): string {
  // Allow HH:MM and HH:MM:SS — DB returns HH:MM:SS; expose HH:MM:SS canonical.
  if (!TIME_RE.test(t)) {
    throw new InvalidSlotTimeError(t, t);
  }
  return t.length === 5 ? `${t}:00` : t;
}

function compareTime(a: string, b: string): number {
  // Lexicographic compare works because both are zero-padded HH:MM:SS.
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * ScheduleTemplateSlot — lives inside a ScheduleTemplate aggregate. Methods
 * are deliberately small: factory + patch + state-export. Conflict detection
 * (two slots sharing day+start_time inside one template) lives on the parent
 * aggregate so the unique-key invariant has a single owner.
 */
export class ScheduleTemplateSlot {
  private constructor(
    readonly id: string,
    readonly templateId: string,
    private _dayOfWeek: DayOfWeekValue,
    private _startTime: string,
    private _endTime: string,
    private _activityName: string,
    private _locationId: string | null,
    private _description: string | null,
  ) {}

  static create(input: {
    id: string;
    templateId: string;
    dayOfWeek: string;
    startTime: string;
    endTime: string;
    activityName: string;
    locationId?: string | null;
    description?: string | null;
  }): ScheduleTemplateSlot {
    if (!isDayOfWeek(input.dayOfWeek)) {
      throw new Error(`invalid day_of_week: ${input.dayOfWeek}`);
    }
    const start = normalizeTime(input.startTime);
    const end = normalizeTime(input.endTime);
    if (compareTime(start, end) >= 0) {
      throw new InvalidSlotTimeError(start, end);
    }
    return new ScheduleTemplateSlot(
      input.id,
      input.templateId,
      input.dayOfWeek,
      start,
      end,
      input.activityName,
      input.locationId ?? null,
      input.description ?? null,
    );
  }

  static hydrate(state: ScheduleTemplateSlotState): ScheduleTemplateSlot {
    return new ScheduleTemplateSlot(
      state.id,
      state.templateId,
      state.dayOfWeek,
      state.startTime,
      state.endTime,
      state.activityName,
      state.locationId,
      state.description,
    );
  }

  get dayOfWeek(): DayOfWeekValue {
    return this._dayOfWeek;
  }
  get startTime(): string {
    return this._startTime;
  }
  get endTime(): string {
    return this._endTime;
  }
  get activityName(): string {
    return this._activityName;
  }
  get locationId(): string | null {
    return this._locationId;
  }
  get description(): string | null {
    return this._description;
  }

  /**
   * Apply a partial patch. Times revalidate together — clients can change one
   * or both. Day-of-week may also be patched.
   */
  patch(patch: {
    dayOfWeek?: string;
    startTime?: string;
    endTime?: string;
    activityName?: string;
    locationId?: string | null;
    description?: string | null;
  }): void {
    if (patch.dayOfWeek !== undefined) {
      if (!isDayOfWeek(patch.dayOfWeek)) {
        throw new Error(`invalid day_of_week: ${patch.dayOfWeek}`);
      }
      this._dayOfWeek = patch.dayOfWeek;
    }
    const nextStart =
      patch.startTime !== undefined
        ? normalizeTime(patch.startTime)
        : this._startTime;
    const nextEnd =
      patch.endTime !== undefined
        ? normalizeTime(patch.endTime)
        : this._endTime;
    if (compareTime(nextStart, nextEnd) >= 0) {
      throw new InvalidSlotTimeError(nextStart, nextEnd);
    }
    this._startTime = nextStart;
    this._endTime = nextEnd;
    if (patch.activityName !== undefined) {
      this._activityName = patch.activityName;
    }
    if (patch.locationId !== undefined) {
      this._locationId = patch.locationId;
    }
    if (patch.description !== undefined) {
      this._description = patch.description;
    }
  }

  toState(): ScheduleTemplateSlotState {
    return {
      id: this.id,
      templateId: this.templateId,
      dayOfWeek: this._dayOfWeek,
      startTime: this._startTime,
      endTime: this._endTime,
      activityName: this._activityName,
      locationId: this._locationId,
      description: this._description,
    };
  }
}
