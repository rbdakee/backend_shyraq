/**
 * Sealed enum-VO mirroring DB enum `timeline_entry_type` (B8 migration).
 *
 * The B8 staff attendance flow only writes `check_in` / `check_out` rows.
 * Other types (`activity`, `meal`, `nap`, `note`, `photo`, `mood`,
 * `medication`) are reserved for the standalone timeline endpoints in T4.
 */
export const TIMELINE_ENTRY_TYPE_VALUES = [
  'check_in',
  'check_out',
  'activity',
  'meal',
  'nap',
  'note',
  'photo',
  'mood',
  'medication',
] as const;

export type TimelineEntryTypeValue =
  (typeof TIMELINE_ENTRY_TYPE_VALUES)[number];

export class TimelineEntryType {
  static readonly CHECK_IN = new TimelineEntryType('check_in');
  static readonly CHECK_OUT = new TimelineEntryType('check_out');
  static readonly ACTIVITY = new TimelineEntryType('activity');
  static readonly MEAL = new TimelineEntryType('meal');
  static readonly NAP = new TimelineEntryType('nap');
  static readonly NOTE = new TimelineEntryType('note');
  static readonly PHOTO = new TimelineEntryType('photo');
  static readonly MOOD = new TimelineEntryType('mood');
  static readonly MEDICATION = new TimelineEntryType('medication');

  private constructor(public readonly value: TimelineEntryTypeValue) {}

  static from(value: string): TimelineEntryType {
    if (!(TIMELINE_ENTRY_TYPE_VALUES as readonly string[]).includes(value)) {
      throw new Error(
        `timeline_entry_type must be one of ${TIMELINE_ENTRY_TYPE_VALUES.join(
          '|',
        )}, got: ${value}`,
      );
    }
    return new TimelineEntryType(value as TimelineEntryTypeValue);
  }

  equals(other: TimelineEntryType): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
