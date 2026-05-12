import { TariffAssignment } from '../../domain/entities/tariff-assignment.entity';

export interface CreateTariffAssignmentInput {
  kindergartenId: string;
  childId: string;
  tariffPlanId: string;
  customAmount: number | null;
  customReason: string | null;
  validFrom: Date;
  validUntil: Date | null;
  assignedBy: string;
}

export interface UpdateTariffAssignmentPatch {
  tariffPlanId?: string;
  customAmount?: number | null;
  customReason?: string | null;
  validFrom?: Date;
  validUntil?: Date | null;
}

export interface ListTariffAssignmentsFilter {
  childId?: string;
}

/**
 * Persistence port for `tariff_assignments`. Provides `findActiveForChild` /
 * `findAllActiveAtDate` consumed by the monthly-generation flow.
 */
export abstract class TariffAssignmentRepository {
  abstract create(
    input: CreateTariffAssignmentInput,
  ): Promise<TariffAssignment>;

  abstract update(
    kindergartenId: string,
    id: string,
    patch: UpdateTariffAssignmentPatch,
    now: Date,
  ): Promise<TariffAssignment | null>;

  /** Persists the aggregate after a mutator (e.g. `close`). */
  abstract save(assignment: TariffAssignment): Promise<TariffAssignment>;

  abstract findById(
    kindergartenId: string,
    id: string,
  ): Promise<TariffAssignment | null>;

  /**
   * Returns the (single) tariff_assignment that covers `atDate` for the
   * given child, or `null`. Tie-break across multiple matches: latest
   * `valid_from` wins.
   */
  abstract findActiveForChild(
    kindergartenId: string,
    childId: string,
    atDate: Date,
  ): Promise<TariffAssignment | null>;

  /**
   * Returns every active assignment in the kindergarten where
   * `validFrom <= atDate AND (validUntil IS NULL OR validUntil >= atDate)`.
   * Used by `InvoiceService.generateMonthly` to enumerate billable
   * children for a given period.
   */
  abstract findAllActiveAtDate(
    kindergartenId: string,
    atDate: Date,
  ): Promise<TariffAssignment[]>;

  /**
   * Returns `true` iff a non-`excludeId` assignment exists for the child
   * whose [validFrom, validUntil] window overlaps the proposed one.
   * Treats both `validUntil=NULL` (open) windows as overlap candidates.
   */
  abstract existsOverlap(
    kindergartenId: string,
    childId: string,
    validFrom: Date,
    validUntil: Date | null,
    excludeId?: string,
  ): Promise<boolean>;

  abstract list(
    kindergartenId: string,
    filter?: ListTariffAssignmentsFilter,
  ): Promise<TariffAssignment[]>;

  /**
   * Acquires `pg_advisory_xact_lock(hashtext('billing:tariff-assign:'||kgId||':'||childId))`.
   * Released automatically on TX commit / rollback.
   *
   * Used by `TariffAssignmentService.assign` and `update` BEFORE the
   * `existsOverlap` SELECT so concurrent admins assigning the same child
   * cannot both pass the overlap check and both INSERT.
   *
   * MUST be called inside an ambient TX — outside one the lock is
   * released at the implicit per-statement boundary (no-op).
   */
  abstract acquireAssignChildAdvisoryLock(
    kindergartenId: string,
    childId: string,
  ): Promise<void>;

  /**
   * B16 — returns the IDs of every child in the kg with an ACTIVE
   * tariff_assignment (validFrom <= now AND (validUntil IS NULL OR
   * validUntil >= now)) for any of `tariffPlanIds`. Used by
   * `DiscountTargetResolver` for the `targetType='tariff_types'` discount
   * target. Empty input returns `[]` without a query.
   *
   * Default no-op so older test fakes keep compiling — the relational
   * impl overrides with the real query.
   */
  listActiveChildIdsByTariffPlanIds(
    _kindergartenId: string,
    _tariffPlanIds: string[],
    _now: Date,
  ): Promise<string[]> {
    return Promise.resolve([]);
  }

  /**
   * B21 — bulk-close every still-active tariff_assignment for `childId` by
   * setting `valid_until = $validUntil` where the existing window has no
   * upper bound or extends past `$validUntil`. Returns the count of rows
   * affected so the caller can log / surface the close to admins.
   *
   * Used by `ChildService.archive` (B21 T3) — archiving a child must stop
   * future invoicing immediately. Open-ended assignments (`valid_until=NULL`)
   * and assignments whose existing `valid_until` is still in the future are
   * both clamped down. Assignments already closed in the past (`valid_until
   * < $validUntil`) are left untouched — there's nothing to truncate.
   *
   * Default no-op so older test fakes keep compiling; the relational impl
   * overrides with the real UPDATE.
   */
  closeActiveForChild(
    _kindergartenId: string,
    _childId: string,
    _validUntil: Date,
  ): Promise<{ closedCount: number }> {
    return Promise.resolve({ closedCount: 0 });
  }
}
