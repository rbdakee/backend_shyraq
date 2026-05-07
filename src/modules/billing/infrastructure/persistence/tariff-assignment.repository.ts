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
}
