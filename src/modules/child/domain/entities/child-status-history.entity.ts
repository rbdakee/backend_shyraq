/**
 * `child_status_history` row — append-only audit record. B22a T9.
 *
 * Treated as a value object (not a rich aggregate): no behaviour beyond
 * `toState()`/`fromState()` and `record(...)` factory which validates the
 * three allowed transitions plus the archive-reason invariant. Persistence
 * happens via the repository port; the entity itself does not know how it
 * is stored.
 *
 * Lives in the domain layer so the repository signature can speak in terms
 * of this type without leaking TypeORM details to the service. No
 * `@nestjs/*`, `typeorm`, `class-validator` imports here — POJO only.
 */
import { ChildStatusHistoryInvalidTransitionError } from '../errors/child-status-history-invalid-transition.error';
import { ChildStatusHistoryMissingArchiveReasonError } from '../errors/child-status-history-missing-archive-reason.error';

export type ChildStatusValue = 'card_created' | 'active' | 'archived';

export interface ChildStatusHistoryState {
  id: string;
  kindergartenId: string;
  childId: string;
  previousStatus: ChildStatusValue;
  newStatus: ChildStatusValue;
  /**
   * Captured BEFORE `Child.reactivate()` clears `archive_reason` on the
   * children row — preserves the audit trail for the prior archive even
   * after reactivation.
   */
  previousArchiveReason: string | null;
  /**
   * Reason for the current archive. Set when `newStatus === 'archived'`,
   * NULL otherwise. The DB CHECK `chk_archive_reason_on_archive` enforces
   * the same invariant at the storage boundary.
   */
  archiveReason: string | null;
  /** `users.id` of the actor — `req.user.sub`, not `staff_members.id`. */
  changedByUserId: string;
  changedAt: Date;
  createdAt: Date;
}

const ALLOWED_TRANSITIONS: ReadonlyArray<
  readonly [ChildStatusValue, ChildStatusValue]
> = [
  ['active', 'archived'],
  ['archived', 'active'],
  ['card_created', 'active'],
];

export interface RecordStatusChangeInput {
  id: string;
  kindergartenId: string;
  childId: string;
  previousStatus: ChildStatusValue;
  newStatus: ChildStatusValue;
  previousArchiveReason: string | null;
  archiveReason: string | null;
  changedByUserId: string;
  changedAt: Date;
}

/**
 * Domain "entity" for a single status-history row. Construction goes
 * through `record(...)` so the same invariants the DB CHECK enforces are
 * also asserted in the application layer (defence-in-depth + better error
 * messages — a 409/422 from the service is friendlier than a raw PG
 * `23514` constraint violation).
 */
export class ChildStatusHistory {
  readonly id: string;
  readonly kindergartenId: string;
  readonly childId: string;
  readonly previousStatus: ChildStatusValue;
  readonly newStatus: ChildStatusValue;
  readonly previousArchiveReason: string | null;
  readonly archiveReason: string | null;
  readonly changedByUserId: string;
  readonly changedAt: Date;
  readonly createdAt: Date;

  private constructor(state: ChildStatusHistoryState) {
    this.id = state.id;
    this.kindergartenId = state.kindergartenId;
    this.childId = state.childId;
    this.previousStatus = state.previousStatus;
    this.newStatus = state.newStatus;
    this.previousArchiveReason = state.previousArchiveReason;
    this.archiveReason = state.archiveReason;
    this.changedByUserId = state.changedByUserId;
    this.changedAt = state.changedAt;
    this.createdAt = state.createdAt;
  }

  /**
   * Build a new record about to be persisted. `createdAt` is set to
   * `changedAt` here as a domain placeholder; the relational repo lets
   * the DB DEFAULT now() produce the canonical createdAt and re-reads it
   * via RETURNING when needed. Callers persist immediately after; no
   * mutation API is exposed.
   */
  static record(input: RecordStatusChangeInput): ChildStatusHistory {
    const ok = ALLOWED_TRANSITIONS.some(
      ([from, to]) => from === input.previousStatus && to === input.newStatus,
    );
    if (!ok) {
      throw new ChildStatusHistoryInvalidTransitionError(
        input.previousStatus,
        input.newStatus,
      );
    }
    if (input.newStatus === 'archived' && !input.archiveReason) {
      throw new ChildStatusHistoryMissingArchiveReasonError();
    }
    return new ChildStatusHistory({
      id: input.id,
      kindergartenId: input.kindergartenId,
      childId: input.childId,
      previousStatus: input.previousStatus,
      newStatus: input.newStatus,
      previousArchiveReason: input.previousArchiveReason,
      archiveReason: input.archiveReason,
      changedByUserId: input.changedByUserId,
      changedAt: input.changedAt,
      createdAt: input.changedAt,
    });
  }

  static hydrate(state: ChildStatusHistoryState): ChildStatusHistory {
    return new ChildStatusHistory(state);
  }

  toState(): ChildStatusHistoryState {
    return {
      id: this.id,
      kindergartenId: this.kindergartenId,
      childId: this.childId,
      previousStatus: this.previousStatus,
      newStatus: this.newStatus,
      previousArchiveReason: this.previousArchiveReason,
      archiveReason: this.archiveReason,
      changedByUserId: this.changedByUserId,
      changedAt: this.changedAt,
      createdAt: this.createdAt,
    };
  }
}
