/**
 * Sealed enum-VO mirroring DB enum-string `notification_outbox.status`
 * (B9 migration `1777627742228-B9NotificationsAndOutbox`):
 *
 *   CHECK (status IN ('pending', 'dispatched', 'failed'))
 *
 * Lifecycle:
 *   pending → dispatched     (terminal, success)
 *   pending → pending        (after a transient failure, attempts < MAX)
 *   pending → failed         (terminal, after attempts >= MAX)
 *
 * Transitions are enforced by `OutboxEvent` (markDispatched / markFailed).
 */
export const OUTBOX_EVENT_STATUS_VALUES = [
  'pending',
  'dispatched',
  'failed',
] as const;

export type OutboxEventStatusValue =
  (typeof OUTBOX_EVENT_STATUS_VALUES)[number];

export class OutboxEventStatus {
  static readonly PENDING = new OutboxEventStatus('pending');
  static readonly DISPATCHED = new OutboxEventStatus('dispatched');
  static readonly FAILED = new OutboxEventStatus('failed');

  private constructor(public readonly value: OutboxEventStatusValue) {}

  static from(value: string): OutboxEventStatus {
    switch (value) {
      case 'pending':
        return OutboxEventStatus.PENDING;
      case 'dispatched':
        return OutboxEventStatus.DISPATCHED;
      case 'failed':
        return OutboxEventStatus.FAILED;
      default:
        throw new Error(
          `outbox_event_status must be one of ${OUTBOX_EVENT_STATUS_VALUES.join(
            '|',
          )}, got: ${value}`,
        );
    }
  }

  equals(other: OutboxEventStatus): boolean {
    return this.value === other.value;
  }

  toString(): string {
    return this.value;
  }
}
