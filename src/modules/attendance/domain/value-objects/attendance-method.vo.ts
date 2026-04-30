/**
 * Sealed enum-VO mirroring DB enum `attendance_method` (B8 migration).
 *
 * Values:
 *   - face_id     — recorded via face-id terminal (B11+)
 *   - manual      — recorded by staff in the app (B8 default for check-in/out)
 *   - otp_pickup  — recorded via OTP pickup flow (B11)
 *
 * The B8 staff endpoints always emit `manual`. Other methods are reserved
 * for later phases.
 */
export const ATTENDANCE_METHOD_VALUES = [
  'face_id',
  'manual',
  'otp_pickup',
] as const;

export type AttendanceMethodValue = (typeof ATTENDANCE_METHOD_VALUES)[number];

export class AttendanceMethod {
  static readonly FACE_ID = new AttendanceMethod('face_id');
  static readonly MANUAL = new AttendanceMethod('manual');
  static readonly OTP_PICKUP = new AttendanceMethod('otp_pickup');

  private constructor(public readonly value: AttendanceMethodValue) {}

  static from(value: string): AttendanceMethod {
    switch (value) {
      case 'face_id':
        return AttendanceMethod.FACE_ID;
      case 'manual':
        return AttendanceMethod.MANUAL;
      case 'otp_pickup':
        return AttendanceMethod.OTP_PICKUP;
      default:
        throw new Error(
          `attendance_method must be one of ${ATTENDANCE_METHOD_VALUES.join(
            '|',
          )}, got: ${value}`,
        );
    }
  }

  equals(other: AttendanceMethod): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
