/**
 * Sealed enum-VO mirroring DB enum `activity_event_status` and the activity
 * event state-machine.
 *
 * State machine (B7 BP §9.3):
 *   scheduled   → in_progress | cancelled
 *   in_progress → completed   | cancelled
 *   completed   → (terminal)
 *   cancelled   → (terminal)
 */
export const ACTIVITY_EVENT_STATUS_VALUES = [
  'scheduled',
  'in_progress',
  'completed',
  'cancelled',
] as const;

export type ActivityEventStatusValue =
  (typeof ACTIVITY_EVENT_STATUS_VALUES)[number];

const TRANSITIONS: Readonly<
  Record<ActivityEventStatusValue, readonly ActivityEventStatusValue[]>
> = {
  scheduled: ['in_progress', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

export class ActivityEventStatus {
  static readonly SCHEDULED = new ActivityEventStatus('scheduled');
  static readonly IN_PROGRESS = new ActivityEventStatus('in_progress');
  static readonly COMPLETED = new ActivityEventStatus('completed');
  static readonly CANCELLED = new ActivityEventStatus('cancelled');

  private constructor(public readonly value: ActivityEventStatusValue) {}

  static from(value: string): ActivityEventStatus {
    switch (value) {
      case 'scheduled':
        return ActivityEventStatus.SCHEDULED;
      case 'in_progress':
        return ActivityEventStatus.IN_PROGRESS;
      case 'completed':
        return ActivityEventStatus.COMPLETED;
      case 'cancelled':
        return ActivityEventStatus.CANCELLED;
      default:
        throw new Error(
          `activity_event_status must be one of ${ACTIVITY_EVENT_STATUS_VALUES.join(
            '|',
          )}, got: ${value}`,
        );
    }
  }

  canTransitionTo(next: ActivityEventStatus): boolean {
    return TRANSITIONS[this.value].includes(next.value);
  }

  isTerminal(): boolean {
    return this.value === 'completed' || this.value === 'cancelled';
  }

  equals(other: ActivityEventStatus): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
