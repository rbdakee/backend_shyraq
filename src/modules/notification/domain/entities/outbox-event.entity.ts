import {
  OutboxEventStatus,
  OutboxEventStatusValue,
} from '../value-objects/outbox-event-status.vo';

/**
 * Maximum delivery attempts before the row goes terminal `failed`. Five
 * attempts with the default `defaultBackoff` schedule below puts a poison
 * row in the dead state within ~75 minutes of the first try.
 */
export const MAX_OUTBOX_ATTEMPTS = 5;

/**
 * Deterministic exponential backoff: `2^attempts` minutes capped at 60min.
 *
 *   attempts=1 →   2 min
 *   attempts=2 →   4 min
 *   attempts=3 →   8 min
 *   attempts=4 →  16 min
 *   attempts=5 →  32 min  (would-be next try; row is terminal at this point)
 *   attempts=6+ →  60 min (cap, kept for safety in case MAX_ATTEMPTS grows)
 *
 * Pure function — domain layer; no env reads, no clock dep, no I/O.
 */
export type BackoffStrategy = (attempts: number) => number; // returns ms

export const defaultBackoff: BackoffStrategy = (attempts: number): number => {
  const safeAttempts = Math.max(1, Math.min(attempts, 30));
  const minutes = Math.min(2 ** safeAttempts, 60);
  return minutes * 60_000;
};

export interface OutboxEventState {
  id: string;
  kindergartenId: string;
  eventKey: string;
  payload: Record<string, unknown>;
  status: OutboxEventStatusValue;
  attempts: number;
  nextRetryAt: Date;
  createdAt: Date;
  dispatchedAt: Date | null;
  failedReason: string | null;
}

export interface CreateOutboxEventInput {
  /**
   * Optional. When omitted, the DB default `gen_random_uuid()` populates
   * the row on insert. When provided (e.g. in tests or in a flow that needs
   * the id ahead of insert), the value is used verbatim.
   */
  id?: string;
  kindergartenId: string;
  eventKey: string;
  payload: Record<string, unknown>;
}

/**
 * OutboxEvent — outbox-table row aggregate.
 *
 * Lifecycle (enforced by methods):
 *   pending  ── markDispatched ─→ dispatched   (terminal)
 *   pending  ── markFailed     ─→ pending      (attempts < MAX, retry scheduled)
 *   pending  ── markFailed     ─→ failed       (attempts >= MAX, terminal)
 *
 * `dispatched` and `failed` are terminal — calling `markDispatched` or
 * `markFailed` on a non-pending row is a programmer error and throws. The
 * dispatcher (T4) is responsible for not double-handling rows; the domain
 * just protects the invariant.
 */
export class OutboxEvent {
  private constructor(
    readonly id: string | undefined,
    readonly kindergartenId: string,
    readonly eventKey: string,
    readonly payload: Record<string, unknown>,
    private _status: OutboxEventStatus,
    private _attempts: number,
    private _nextRetryAt: Date,
    readonly createdAt: Date,
    private _dispatchedAt: Date | null,
    private _failedReason: string | null,
  ) {}

  static create(input: CreateOutboxEventInput, now: Date): OutboxEvent {
    return new OutboxEvent(
      input.id,
      input.kindergartenId,
      input.eventKey,
      input.payload,
      OutboxEventStatus.PENDING,
      0,
      now,
      now,
      null,
      null,
    );
  }

  static hydrate(state: OutboxEventState): OutboxEvent {
    return new OutboxEvent(
      state.id,
      state.kindergartenId,
      state.eventKey,
      state.payload,
      OutboxEventStatus.from(state.status),
      state.attempts,
      state.nextRetryAt,
      state.createdAt,
      state.dispatchedAt,
      state.failedReason,
    );
  }

  // ── getters ──────────────────────────────────────────────────────────────

  get status(): OutboxEventStatus {
    return this._status;
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextRetryAt(): Date {
    return this._nextRetryAt;
  }

  get dispatchedAt(): Date | null {
    return this._dispatchedAt;
  }

  get failedReason(): string | null {
    return this._failedReason;
  }

  isTerminal(): boolean {
    return (
      this._status.equals(OutboxEventStatus.DISPATCHED) ||
      this._status.equals(OutboxEventStatus.FAILED)
    );
  }

  // ── mutators ─────────────────────────────────────────────────────────────

  /**
   * Mark the event as successfully dispatched. Throws if the row is already
   * in a terminal state — the dispatcher must guard against double-handling
   * before calling.
   */
  markDispatched(now: Date): void {
    if (!this._status.equals(OutboxEventStatus.PENDING)) {
      throw new Error(
        `outbox_event_already_terminal: status=${this._status.value}`,
      );
    }
    this._status = OutboxEventStatus.DISPATCHED;
    this._dispatchedAt = now;
  }

  /**
   * Mark the event as failed for this attempt. Increments `attempts`. If the
   * incremented count reaches `maxAttempts`, status becomes terminal `failed`
   * and `nextRetryAt` is left at the time-of-failure (informational only —
   * the partial index `idx_outbox_pending` excludes the row from polling).
   * Otherwise the row stays `pending` and `nextRetryAt = now + backoff(attempts)`,
   * picked up by the next poll cycle.
   *
   * Throws if called on an already-terminal row — that would corrupt the
   * attempts counter / state.
   */
  markFailed(
    now: Date,
    reason: string,
    backoff: BackoffStrategy = defaultBackoff,
    maxAttempts: number = MAX_OUTBOX_ATTEMPTS,
  ): void {
    if (!this._status.equals(OutboxEventStatus.PENDING)) {
      throw new Error(
        `outbox_event_already_terminal: status=${this._status.value}`,
      );
    }
    this._attempts += 1;
    this._failedReason = reason;
    if (this._attempts >= maxAttempts) {
      this._status = OutboxEventStatus.FAILED;
      this._nextRetryAt = now;
      return;
    }
    this._nextRetryAt = new Date(now.getTime() + backoff(this._attempts));
  }

  toState(): OutboxEventState {
    return {
      id: this.id ?? '',
      kindergartenId: this.kindergartenId,
      eventKey: this.eventKey,
      payload: this.payload,
      status: this._status.value,
      attempts: this._attempts,
      nextRetryAt: this._nextRetryAt,
      createdAt: this.createdAt,
      dispatchedAt: this._dispatchedAt,
      failedReason: this._failedReason,
    };
  }
}
