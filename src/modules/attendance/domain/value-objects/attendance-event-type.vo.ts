/**
 * Sealed enum-VO mirroring DB enum `attendance_event_type` (B8 migration).
 *
 * The type is fixed at row creation and never transitions as part of normal
 * operation. The one exception is an explicit admin correction of a
 * mis-pressed button (`AttendanceEvent.applyPatch({ eventType })`), which is
 * journalled to `audit_log`.
 */
export const ATTENDANCE_EVENT_TYPE_VALUES = ['check_in', 'check_out'] as const;

export type AttendanceEventTypeValue =
  (typeof ATTENDANCE_EVENT_TYPE_VALUES)[number];

export class AttendanceEventType {
  static readonly CHECK_IN = new AttendanceEventType('check_in');
  static readonly CHECK_OUT = new AttendanceEventType('check_out');

  private constructor(public readonly value: AttendanceEventTypeValue) {}

  static from(value: string): AttendanceEventType {
    switch (value) {
      case 'check_in':
        return AttendanceEventType.CHECK_IN;
      case 'check_out':
        return AttendanceEventType.CHECK_OUT;
      default:
        throw new Error(
          `attendance_event_type must be one of ${ATTENDANCE_EVENT_TYPE_VALUES.join(
            '|',
          )}, got: ${value}`,
        );
    }
  }

  equals(other: AttendanceEventType): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
