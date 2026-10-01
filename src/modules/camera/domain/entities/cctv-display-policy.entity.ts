import { InvariantViolationError } from '@/shared-kernel/domain/errors';
import {
  combineDateAndTimeInTimezone,
  isoWeekdayOf,
  KG_DEFAULT_TIMEZONE,
} from '@/shared-kernel/domain/value-objects/day-of-week.vo';

/**
 * "Do not show these common cameras on these days between `from` and `to`."
 *
 * The window is wall-clock time in the kindergarten's zone. `from > to` means
 * the window runs past midnight (19:00–08:00): it belongs to the day it starts
 * on, so a Friday night rule also covers early Saturday morning.
 */
export interface CctvHideRule {
  /** Admin's own label, e.g. «Обед». May be empty. */
  name: string;
  /** A disabled rule is kept for later but never applies. */
  enabled: boolean;
  /** ISO weekdays the window starts on: 1=Mon … 7=Sun. */
  days: number[];
  /** `HH:MM`, kindergarten-local. */
  from: string;
  to: string;
  /** Hide every common camera — the rule then ignores `cameraIds`. */
  allCameras: boolean;
  /** Common cameras to hide. Each must be one of the policy's common cameras. */
  cameraIds: string[];
}

export interface CctvDisplayPolicyState {
  kindergartenId: string;
  /** Shown to every parent, in this order, unless a rule hides them. */
  commonCameraIds: string[];
  hideRules: CctvHideRule[];
  createdAt: Date;
  updatedAt: Date;
}

const WALL_CLOCK_RE = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;
const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];

/**
 * Error codes this entity raises. `InvariantViolationError` carries the code
 * straight to the HTTP body, so these are contract: the admin panel maps them
 * to messages. Slugs, never sentences.
 */
export const CCTV_POLICY_TIME_INVALID = 'cctv_policy_time_invalid';
export const CCTV_POLICY_WINDOW_INVALID = 'cctv_policy_window_invalid';
export const CCTV_POLICY_WORK_DAY_INVALID = 'cctv_policy_work_day_invalid';
export const CCTV_POLICY_RULE_CAMERA_NOT_COMMON =
  'cctv_policy_rule_camera_not_common';

/** `'19:00:00'` and `'19:00'` both land on `'19:00'`. */
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

function normalizeDays(days: number[]): number[] {
  for (const day of days) {
    if (!Number.isInteger(day) || day < 1 || day > 7) {
      throw new InvariantViolationError(CCTV_POLICY_WORK_DAY_INVALID);
    }
  }
  return [...new Set(days)].sort((a, b) => a - b);
}

function normalizeRule(
  rule: CctvHideRule,
  commonCameraIds: ReadonlySet<string>,
): CctvHideRule {
  const from = normalizeWallClock(rule.from);
  const to = normalizeWallClock(rule.to);
  // An empty window hides nothing and a 24h one is ambiguous — refuse both.
  if (from === to)
    throw new InvariantViolationError(CCTV_POLICY_WINDOW_INVALID);
  const cameraIds = rule.allCameras ? [] : [...new Set(rule.cameraIds)];
  // Hiding a camera parents are not shown anyway is a no-op the admin did not
  // mean; say so while they are still on the screen.
  if (cameraIds.some((id) => !commonCameraIds.has(id))) {
    throw new InvariantViolationError(CCTV_POLICY_RULE_CAMERA_NOT_COMMON);
  }
  return {
    name: rule.name.trim(),
    enabled: rule.enabled,
    days: normalizeDays(rule.days),
    from,
    to,
    allCameras: rule.allCameras,
    cameraIds,
  };
}

function copyRule(rule: CctvHideRule): CctvHideRule {
  return { ...rule, days: [...rule.days], cameraIds: [...rule.cameraIds] };
}

/**
 * CctvDisplayPolicy — the kindergarten's answer to "what do parents see, and
 * when", read on every parent CCTV request.
 *
 * A parent always sees the cameras of the room their child's group is
 * assigned to; that part is not configurable. On top of it the kindergarten
 * picks common cameras shown to everyone (canteen, clubs), and time rules that
 * hide some or all of those common cameras — lunch break, night.
 *
 * `default()` is what a kindergarten has before it saves anything: no common
 * cameras, and a night rule prepared but switched off.
 */
export class CctvDisplayPolicy {
  private constructor(
    readonly kindergartenId: string,
    private _commonCameraIds: string[],
    private _hideRules: CctvHideRule[],
    readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static hydrate(state: CctvDisplayPolicyState): CctvDisplayPolicy {
    // Duplicates would render the same camera twice; first position wins so
    // the admin's ordering survives.
    const commonCameraIds = [...new Set(state.commonCameraIds)];
    const common = new Set(commonCameraIds);
    return new CctvDisplayPolicy(
      state.kindergartenId,
      commonCameraIds,
      state.hideRules.map((rule) => normalizeRule(rule, common)),
      state.createdAt,
      state.updatedAt,
    );
  }

  static defaultNightRule(): CctvHideRule {
    return {
      name: 'Ночь',
      enabled: false,
      days: [...ALL_DAYS],
      from: '19:00',
      to: '08:00',
      allCameras: true,
      cameraIds: [],
    };
  }

  static default(kindergartenId: string, now: Date): CctvDisplayPolicy {
    return CctvDisplayPolicy.hydrate({
      kindergartenId,
      commonCameraIds: [],
      hideRules: [CctvDisplayPolicy.defaultNightRule()],
      createdAt: now,
      updatedAt: now,
    });
  }

  get commonCameraIds(): string[] {
    return [...this._commonCameraIds];
  }
  get hideRules(): CctvHideRule[] {
    return this._hideRules.map(copyRule);
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** Every camera the policy names — the write-side existence check. */
  get referencedCameraIds(): string[] {
    return this.commonCameraIds;
  }

  /** Common cameras parents see at `instant`, in the admin's order. */
  visibleCommonCameraIds(
    instant: Date,
    timeZone: string = KG_DEFAULT_TIMEZONE,
  ): string[] {
    const hidden = new Set<string>();
    for (const rule of this._hideRules) {
      if (!rule.enabled || !ruleCovers(rule, instant, timeZone)) continue;
      if (rule.allCameras) return [];
      rule.cameraIds.forEach((id) => hidden.add(id));
    }
    return this._commonCameraIds.filter((id) => !hidden.has(id));
  }

  toState(): CctvDisplayPolicyState {
    return {
      kindergartenId: this.kindergartenId,
      commonCameraIds: this.commonCameraIds,
      hideRules: this.hideRules,
      createdAt: this.createdAt,
      updatedAt: this._updatedAt,
    };
  }
}

/**
 * True when `instant` falls inside the rule's window, in local time. The zone
 * matters: 19:30 Almaty is 14:30Z, and comparing UTC wall clocks would put
 * the evening in the afternoon.
 */
function ruleCovers(
  rule: CctvHideRule,
  instant: Date,
  timeZone: string,
): boolean {
  const weekday = isoWeekdayOf(instant, timeZone);
  const start = combineDateAndTimeInTimezone(instant, rule.from, timeZone);
  const end = combineDateAndTimeInTimezone(instant, rule.to, timeZone);
  if (rule.from < rule.to) {
    return rule.days.includes(weekday) && instant >= start && instant < end;
  }
  // Past midnight: the evening part belongs to today, the early-morning part
  // to the window that started yesterday.
  const yesterday = weekday === 1 ? 7 : weekday - 1;
  return (
    (rule.days.includes(weekday) && instant >= start) ||
    (rule.days.includes(yesterday) && instant < end)
  );
}
