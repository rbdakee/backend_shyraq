/**
 * Sealed enum-VO mirroring DB enum `child_intraday_status` (B8 migration).
 *
 * The state captured by `child_daily_status` is per (child, day) — values
 * track intra-day presence/absence of the child:
 *
 *   present       — child is at the kindergarten
 *   absent        — known absence (default after the day rolls over)
 *   sick          — sick day (parent-reported or staff-recorded)
 *   late          — parent flagged late arrival; check-in promotes to present
 *   early_pickup  — picked up early (intra-day side-effect; check_out itself
 *                   does NOT mutate daily_status, only setDailyStatus does)
 *   on_vacation   — multi-day absence on vacation
 *
 * Promotion rules (used by AttendanceService.checkIn):
 *   absent | late                  → present  (auto on first check-in of the day)
 *   present | sick | early_pickup
 *     | on_vacation                 → no-op   (preserve prior status)
 */
export const CHILD_INTRADAY_STATUS_VALUES = [
  'present',
  'absent',
  'sick',
  'late',
  'early_pickup',
  'on_vacation',
] as const;

export type ChildIntradayStatusValue =
  (typeof CHILD_INTRADAY_STATUS_VALUES)[number];

export class ChildIntradayStatus {
  static readonly PRESENT = new ChildIntradayStatus('present');
  static readonly ABSENT = new ChildIntradayStatus('absent');
  static readonly SICK = new ChildIntradayStatus('sick');
  static readonly LATE = new ChildIntradayStatus('late');
  static readonly EARLY_PICKUP = new ChildIntradayStatus('early_pickup');
  static readonly ON_VACATION = new ChildIntradayStatus('on_vacation');

  private constructor(public readonly value: ChildIntradayStatusValue) {}

  static from(value: string): ChildIntradayStatus {
    switch (value) {
      case 'present':
        return ChildIntradayStatus.PRESENT;
      case 'absent':
        return ChildIntradayStatus.ABSENT;
      case 'sick':
        return ChildIntradayStatus.SICK;
      case 'late':
        return ChildIntradayStatus.LATE;
      case 'early_pickup':
        return ChildIntradayStatus.EARLY_PICKUP;
      case 'on_vacation':
        return ChildIntradayStatus.ON_VACATION;
      default:
        throw new Error(
          `child_intraday_status must be one of ${CHILD_INTRADAY_STATUS_VALUES.join(
            '|',
          )}, got: ${value}`,
        );
    }
  }

  /**
   * True when an explicit check-in should overwrite the prior status. Only
   * `absent` and `late` are check-in-promotable to `present`. Every other
   * status represents an explicit operator decision and is preserved.
   */
  isPromotableByCheckIn(): boolean {
    return this.value === 'absent' || this.value === 'late';
  }

  equals(other: ChildIntradayStatus): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
