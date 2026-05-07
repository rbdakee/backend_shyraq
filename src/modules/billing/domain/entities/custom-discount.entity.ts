import { InvariantViolationError } from '@/shared-kernel/domain/errors';
import {
  ConditionsRoot,
  validateConditionsSchema,
} from '../discount-conditions/conditions-evaluator';
import { CustomDiscountAmountInvalidError } from '../errors/custom-discount-amount-invalid.error';
import { CustomDiscountStatusInvalidError } from '../errors/custom-discount-status-invalid.error';
import { CustomDiscountTargetInvalidError } from '../errors/custom-discount-target-invalid.error';
import { CustomDiscountValidityInvalidError } from '../errors/custom-discount-validity-invalid.error';

export type CustomDiscountStatus =
  | 'draft'
  | 'active'
  | 'paused'
  | 'expired'
  | 'cancelled';

export type CustomDiscountType = 'percentage' | 'fixed_amount';

/**
 * Targeting modes for a custom discount:
 *   - `all`           — applies to every eligible child in the kg
 *   - `groups`        — `targetIds` is non-empty list of group ids
 *   - `children`      — `targetIds` is non-empty list of child ids
 *   - `tariff_types`  — `targetIds` is unused; the actual filter sits in
 *                       `conditions.tariff_types.in`. We keep the
 *                       targetType for catalogue listing UX.
 *   - `age_range`     — `targetIds` may be null; the actual range sits in
 *                       `conditions.age_range`. Same listing-UX rationale.
 */
export type CustomDiscountTargetType =
  | 'all'
  | 'groups'
  | 'children'
  | 'tariff_types'
  | 'age_range';

const KNOWN_TARGET_TYPES: ReadonlySet<CustomDiscountTargetType> = new Set([
  'all',
  'groups',
  'children',
  'tariff_types',
  'age_range',
]);

/**
 * Localised JSONB blob ({ kk?, ru?, en? }) — the entity does not enforce
 * a particular shape; the DTO layer narrows it. Stored verbatim.
 */
export type LocalisedText = Record<string, string>;

export interface CustomDiscountState {
  id: string;
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
  usedCount: number;
  priority: number;
  stackable: boolean;
  notifyOnActivation: boolean;
  notificationTitle: LocalisedText | null;
  notificationBody: LocalisedText | null;
  status: CustomDiscountStatus;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * CustomDiscount aggregate (B16). Owns the state machine
 *
 *   draft   ──activate──►  active
 *   active  ──pause──►     paused
 *   paused  ──resume──►    active
 *   draft   ──cancel──►    cancelled
 *   active  ──cancel──►    cancelled
 *   paused  ──cancel──►    cancelled
 *   active  ──markExpired──► expired
 *   paused  ──markExpired──► expired   (validUntil may pass while paused)
 *
 * `expired` and `cancelled` are terminal.
 *
 * Invariants enforced by the constructor (so DB-row hydration that has
 * been corrupted manually fails fast):
 *   - `amount > 0`                              (mirrors DB CHECK)
 *   - `validUntil === null || validUntil > validFrom`
 *   - `usedCount >= 0`                          (mirrors DB CHECK)
 *   - `priority >= 0`                           (mirrors DB CHECK)
 *   - `conditions` JSONB matches the schema
 *     (delegates to `validateConditionsSchema` from the evaluator)
 *   - target shape:
 *       * `all`                              → targetIds null or []
 *       * `groups | children | tariff_types` → targetIds non-empty array
 *           (note: for `tariff_types` the actual filter lives in
 *            `conditions.tariff_types.in`; targetIds here is a
 *            duplicated UX hint kept for catalogue listing)
 *       * `age_range`                        → targetIds may be null
 *           (the range itself lives in `conditions.age_range`)
 *
 * Money is held as plain `number` (KZT, 2 decimal places) per
 * billing-module convention. Mappers serialise to PG `numeric(10,2)`.
 */
export class CustomDiscount {
  private constructor(private state: CustomDiscountState) {
    // amount must be strictly positive (mirrors DB chk)
    if (!(state.amount > 0)) {
      throw new CustomDiscountAmountInvalidError(state.amount);
    }
    // valid_until > valid_from
    if (
      state.validUntil !== null &&
      state.validUntil.getTime() <= state.validFrom.getTime()
    ) {
      throw new CustomDiscountValidityInvalidError(
        state.validFrom,
        state.validUntil,
      );
    }
    if (!Number.isInteger(state.usedCount) || state.usedCount < 0) {
      // negative usedCount is a programmer error / corrupted row
      throw new InvariantViolationError('custom_discount_used_count_invalid');
    }
    if (!Number.isInteger(state.priority) || state.priority < 0) {
      throw new InvariantViolationError('custom_discount_priority_invalid');
    }
    if (!KNOWN_TARGET_TYPES.has(state.targetType)) {
      throw new CustomDiscountTargetInvalidError(
        state.targetType,
        'unknown_target_type',
      );
    }
    // target shape rules
    const tgt = state.targetType;
    const ids = state.targetIds;
    if (tgt === 'all') {
      if (ids !== null && ids.length > 0) {
        throw new CustomDiscountTargetInvalidError(
          tgt,
          'target_ids_must_be_empty',
        );
      }
    } else if (
      tgt === 'groups' ||
      tgt === 'children' ||
      tgt === 'tariff_types'
    ) {
      if (ids === null || ids.length === 0) {
        throw new CustomDiscountTargetInvalidError(tgt, 'target_ids_required');
      }
    }
    // For `age_range`, targetIds is allowed to be null — the actual range
    // lives in conditions.age_range; nothing to validate here.

    // conditions schema — throws CustomDiscountConditionsInvalidError on
    // malformed input. Re-assign normalised value back so callers see the
    // canonicalised tree.
    this.state.conditions = validateConditionsSchema(state.conditions);
  }

  static fromState(s: CustomDiscountState): CustomDiscount {
    return new CustomDiscount({ ...s });
  }

  toState(): CustomDiscountState {
    return { ...this.state };
  }

  // ── getters ────────────────────────────────────────────────────────────

  get id(): string {
    return this.state.id;
  }
  get kindergartenId(): string {
    return this.state.kindergartenId;
  }
  get name(): LocalisedText {
    return this.state.name;
  }
  get description(): LocalisedText | null {
    return this.state.description;
  }
  get discountType(): CustomDiscountType {
    return this.state.discountType;
  }
  get amount(): number {
    return this.state.amount;
  }
  get conditions(): ConditionsRoot {
    return this.state.conditions;
  }
  get targetType(): CustomDiscountTargetType {
    return this.state.targetType;
  }
  get targetIds(): string[] | null {
    return this.state.targetIds;
  }
  get validFrom(): Date {
    return this.state.validFrom;
  }
  get validUntil(): Date | null {
    return this.state.validUntil;
  }
  get maxUsesPerChild(): number | null {
    return this.state.maxUsesPerChild;
  }
  get totalMaxUses(): number | null {
    return this.state.totalMaxUses;
  }
  get usedCount(): number {
    return this.state.usedCount;
  }
  get priority(): number {
    return this.state.priority;
  }
  get stackable(): boolean {
    return this.state.stackable;
  }
  get notifyOnActivation(): boolean {
    return this.state.notifyOnActivation;
  }
  get notificationTitle(): LocalisedText | null {
    return this.state.notificationTitle;
  }
  get notificationBody(): LocalisedText | null {
    return this.state.notificationBody;
  }
  get status(): CustomDiscountStatus {
    return this.state.status;
  }
  get createdBy(): string | null {
    return this.state.createdBy;
  }
  get createdAt(): Date {
    return this.state.createdAt;
  }
  get updatedAt(): Date {
    return this.state.updatedAt;
  }

  // ── predicates ─────────────────────────────────────────────────────────

  /**
   * `true` iff status === 'active' AND `now` falls within the validity
   * window (inclusive both ends; `validUntil === null` means open-ended).
   */
  isActive(now: Date): boolean {
    if (this.state.status !== 'active') return false;
    if (now.getTime() < this.state.validFrom.getTime()) return false;
    if (
      this.state.validUntil !== null &&
      now.getTime() > this.state.validUntil.getTime()
    ) {
      return false;
    }
    return true;
  }

  isExpiredByDate(now: Date): boolean {
    return (
      this.state.validUntil !== null &&
      now.getTime() > this.state.validUntil.getTime()
    );
  }

  isUsageLimitReached(): boolean {
    return (
      this.state.totalMaxUses !== null &&
      this.state.usedCount >= this.state.totalMaxUses
    );
  }

  isTerminal(): boolean {
    return this.state.status === 'expired' || this.state.status === 'cancelled';
  }

  // ── transitions ────────────────────────────────────────────────────────

  activate(now: Date): void {
    if (this.state.status !== 'draft') {
      throw new CustomDiscountStatusInvalidError(this.state.status, 'activate');
    }
    this.state.status = 'active';
    this.state.updatedAt = now;
  }

  pause(now: Date): void {
    if (this.state.status !== 'active') {
      throw new CustomDiscountStatusInvalidError(this.state.status, 'pause');
    }
    this.state.status = 'paused';
    this.state.updatedAt = now;
  }

  resume(now: Date): void {
    if (this.state.status !== 'paused') {
      throw new CustomDiscountStatusInvalidError(this.state.status, 'resume');
    }
    this.state.status = 'active';
    this.state.updatedAt = now;
  }

  cancel(now: Date): void {
    if (
      this.state.status !== 'draft' &&
      this.state.status !== 'active' &&
      this.state.status !== 'paused'
    ) {
      throw new CustomDiscountStatusInvalidError(this.state.status, 'cancel');
    }
    this.state.status = 'cancelled';
    this.state.updatedAt = now;
  }

  markExpired(now: Date): void {
    if (this.state.status !== 'active' && this.state.status !== 'paused') {
      throw new CustomDiscountStatusInvalidError(
        this.state.status,
        'markExpired',
      );
    }
    this.state.status = 'expired';
    this.state.updatedAt = now;
  }
}
