import { EntityManager } from 'typeorm';
import {
  CustomDiscount,
  CustomDiscountStatus,
  CustomDiscountTargetType,
  CustomDiscountType,
  LocalisedText,
} from './domain/entities/custom-discount.entity';
import { ConditionsRoot } from './domain/discount-conditions/conditions-evaluator';

/**
 * Pagination request shared with `findApplications` etc. Offset-based — B22
 * may extend with cursor pagination once admin lists exceed the demo size.
 */
export interface CustomDiscountPageRequest {
  limit: number;
  offset: number;
}

/**
 * Inputs for `CustomDiscountRepository.create`. Mirrors all draft-time
 * fields on `custom_discounts`. `usedCount` and `status` are not in the
 * input shape — the relational impl initialises them via column defaults
 * (`0` and `'draft'`).
 */
export interface CreateCustomDiscountInput {
  kindergartenId: string;
  name: LocalisedText;
  description: LocalisedText | null;
  discountType: CustomDiscountType;
  amount: number;
  conditions: ConditionsRoot;
  targetType: CustomDiscountTargetType;
  targetIds: string[] | null;
  validFrom: Date;
  validUntil: Date | null;
  maxUsesPerChild: number | null;
  totalMaxUses: number | null;
  priority: number;
  stackable: boolean;
  notifyOnActivation: boolean;
  notificationTitle: LocalisedText | null;
  notificationBody: LocalisedText | null;
  createdBy: string | null;
}

/**
 * Patch shape for `CustomDiscountRepository.update`. Excludes
 * `id`/`kindergartenId`/`status`/`createdAt`/`createdBy`/`usedCount` —
 * those are immutable once the row exists. Service layer enforces
 * draft-only update; repo just maps fields.
 */
export interface UpdateCustomDiscountPatch {
  name?: LocalisedText;
  description?: LocalisedText | null;
  discountType?: CustomDiscountType;
  amount?: number;
  conditions?: ConditionsRoot;
  targetType?: CustomDiscountTargetType;
  targetIds?: string[] | null;
  validFrom?: Date;
  validUntil?: Date | null;
  maxUsesPerChild?: number | null;
  totalMaxUses?: number | null;
  priority?: number;
  stackable?: boolean;
  notifyOnActivation?: boolean;
  notificationTitle?: LocalisedText | null;
  notificationBody?: LocalisedText | null;
}

export interface ListCustomDiscountsFilter {
  status?: CustomDiscountStatus;
  /** ISO date — filters `valid_from <= validFromTo`. */
  validFromTo?: Date;
  /** ISO date — filters `valid_until >= validUntilFrom OR valid_until IS NULL`. */
  validUntilFrom?: Date;
}

/**
 * Persistence port for `custom_discounts`.
 *
 * All write methods accept an optional `manager?: EntityManager` so the
 * service layer can run them inside an explicit ambient TX (the
 * activation flow holds an advisory lock + does the conditional UPDATE
 * + emits the outbox event in a single TX so the rollback is atomic).
 *
 * Read methods rely on `tenantStorage.getStore()?.entityManager` so RLS
 * scoping is automatic on the HTTP path.
 */
export abstract class CustomDiscountRepository {
  abstract create(input: CreateCustomDiscountInput): Promise<CustomDiscount>;

  abstract findById(
    kindergartenId: string,
    id: string,
  ): Promise<CustomDiscount | null>;

  /**
   * Same as `findById` but issues `SELECT ... FOR UPDATE`. Used by the
   * service before the conditional status flip in `activate()` so the
   * row is row-locked for the duration of the ambient TX.
   */
  abstract findByIdForUpdate(
    kindergartenId: string,
    id: string,
    manager?: EntityManager,
  ): Promise<CustomDiscount | null>;

  /**
   * Conditional UPDATE: applies `patch` only if the current row's status
   * matches `expectedStatus`. Returns the hydrated domain on success or
   * `null` when 0 rows match. When `expectedStatus` is omitted the patch
   * applies regardless of status (used by service when the caller
   * already loaded the row under FOR UPDATE).
   */
  abstract update(
    kindergartenId: string,
    id: string,
    patch: UpdateCustomDiscountPatch,
    expectedStatus?: CustomDiscountStatus,
    manager?: EntityManager,
  ): Promise<CustomDiscount | null>;

  /**
   * Conditional state transition: `SET status=$to, updated_at=$now WHERE
   * id=$id AND kindergarten_id=$kg AND status IN (...$from)`. Returns
   * the hydrated row on success, `null` on 0 rows. Multi-status
   * `fromStatus` covers the cancel-from-{draft|active|paused} case.
   */
  abstract transitionStatus(
    kindergartenId: string,
    id: string,
    fromStatus: CustomDiscountStatus | CustomDiscountStatus[],
    toStatus: CustomDiscountStatus,
    now: Date,
    manager?: EntityManager,
  ): Promise<CustomDiscount | null>;

  abstract list(
    kindergartenId: string,
    filter: ListCustomDiscountsFilter,
    pagination: CustomDiscountPageRequest,
  ): Promise<{ rows: CustomDiscount[]; total: number }>;

  /**
   * Atomic `used_count` bump. SQL:
   *   `UPDATE ... SET used_count = used_count + $by, updated_at = now()
   *      WHERE kindergarten_id=$kg AND id=$id
   *        AND (total_max_uses IS NULL OR used_count + $by <= total_max_uses)
   *      RETURNING true`
   * Returns `true` when the row updated, `false` when total_max_uses was
   * reached (or wrong tenant). Caller decides whether to fail the
   * application or fall through (race: log + skip is the documented
   * trade-off in T3 §F).
   */
  abstract incrementUsedCount(
    kindergartenId: string,
    id: string,
    by: number,
    manager?: EntityManager,
  ): Promise<boolean>;

  /**
   * Pre-loaded by `InvoiceService` before invoice generation. Returns all
   * `status='active'` rows for the kg whose validity window covers `now`,
   * ordered by `priority DESC, created_at ASC` (engine reuses this order
   * for stacking).
   */
  abstract findActiveCustomDiscounts(
    kindergartenId: string,
    now: Date,
    manager?: EntityManager,
  ): Promise<CustomDiscount[]>;

  /**
   * Rows with `status='active' AND valid_until <= now`. Used by the
   * `DiscountExpireProcessor` for visibility — `markExpiredBatch` does
   * the actual UPDATE.
   */
  abstract findOverdueActive(
    kindergartenId: string,
    now: Date,
    manager?: EntityManager,
  ): Promise<CustomDiscount[]>;

  /**
   * Idempotent bulk `active → expired` flip:
   *   `UPDATE ... SET status='expired', updated_at=$now
   *      WHERE kindergarten_id=$kg AND status='active'
   *        AND valid_until <= $now
   *      RETURNING id`.
   *
   * Returns the affected row IDs + count. BP §4.1 specifies the
   * processor is silent (no notification emit), so the service maps
   * the result to a logged `expiredIds` summary only.
   */
  abstract markExpiredBatch(
    kindergartenId: string,
    now: Date,
    manager?: EntityManager,
  ): Promise<{ rowIds: string[]; rowCount: number }>;

  /**
   * `pg_advisory_xact_lock(hashtext('discount:activation:' || $kg || ':' || $id))`.
   * Service uses this BEFORE the conditional UPDATE in `activate()` so
   * concurrent activation attempts on the same draft serialise.
   *
   * Released automatically on TX commit / rollback. Outside an ambient
   * TX it effectively no-ops (released at the implicit per-statement
   * boundary).
   */
  abstract acquireDiscountActivationAdvisoryLock(
    kindergartenId: string,
    id: string,
    manager?: EntityManager,
  ): Promise<void>;
}
