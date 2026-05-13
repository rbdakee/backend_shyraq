import { MoneyKzt } from '@/shared-kernel/domain/money-kzt';

export type TariffType =
  | 'monthly'
  | 'additional_service'
  | 'late_pickup_fee'
  | 'prepayment_3m'
  | 'prepayment_6m'
  | 'prepayment_12m'
  | 'prepayment_24m'
  | 'other';

export type TariffAppliesTo =
  | 'all_children'
  | 'group'
  | 'age_range'
  | 'individual';

/**
 * Discount-rule bag persisted as `jsonb`. **snake_case keys** because the
 * column is read as-is by services without renaming — this lets ops tweak
 * config from psql without a code change. Camel-case TS layer values are
 * only re-exposed at the DTO boundary.
 */
export interface DiscountRules {
  sibling_discount_pct?: number;
  prepay_3m_pct?: number;
  prepay_6m_pct?: number;
  prepay_12m_pct?: number;
  prepay_24m_pct?: number;
  benefit_category?: string;
}

export interface TariffPlanState {
  id: string;
  kindergartenId: string;
  name: string;
  description: Record<string, string>;
  tariffType: TariffType;
  amount: MoneyKzt;
  currency: string;
  appliesTo: TariffAppliesTo;
  groupId: string | null;
  ageMinMonths: number | null;
  ageMaxMonths: number | null;
  isActive: boolean;
  validFrom: Date;
  validUntil: Date | null;
  discountRules: DiscountRules;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * TariffPlan — CRUD POJO with structural invariants on construction:
 *
 *   appliesTo='group'      → groupId required
 *   appliesTo='age_range'  → ageMin/ageMax required, ageMin <= ageMax
 *   validUntil set         → validUntil >= validFrom
 *
 * `deactivate(now)` is the only state mutator — closes the plan by
 * setting `isActive=false` and `validUntil = today`.
 */
export class TariffPlan {
  private constructor(private state: TariffPlanState) {
    if (state.appliesTo === 'group' && state.groupId === null) {
      throw new Error('TariffPlan: groupId is required when appliesTo=group');
    }
    if (state.appliesTo === 'age_range') {
      if (state.ageMinMonths === null || state.ageMaxMonths === null) {
        throw new Error(
          'TariffPlan: ageMinMonths and ageMaxMonths are required when appliesTo=age_range',
        );
      }
      if (state.ageMinMonths > state.ageMaxMonths) {
        throw new Error('TariffPlan: ageMinMonths must be <= ageMaxMonths');
      }
    }
    if (
      state.validUntil !== null &&
      state.validUntil.getTime() < state.validFrom.getTime()
    ) {
      throw new Error('TariffPlan: validUntil must be >= validFrom');
    }
  }

  static fromState(s: TariffPlanState): TariffPlan {
    return new TariffPlan({ ...s });
  }

  toState(): TariffPlanState {
    return { ...this.state };
  }

  // ── getters ────────────────────────────────────────────────────────────

  get id(): string {
    return this.state.id;
  }

  get kindergartenId(): string {
    return this.state.kindergartenId;
  }

  get name(): string {
    return this.state.name;
  }

  get description(): Record<string, string> {
    return this.state.description;
  }

  get tariffType(): TariffType {
    return this.state.tariffType;
  }

  get amount(): MoneyKzt {
    return this.state.amount;
  }

  get currency(): string {
    return this.state.currency;
  }

  get appliesTo(): TariffAppliesTo {
    return this.state.appliesTo;
  }

  get groupId(): string | null {
    return this.state.groupId;
  }

  get ageMinMonths(): number | null {
    return this.state.ageMinMonths;
  }

  get ageMaxMonths(): number | null {
    return this.state.ageMaxMonths;
  }

  get isActive(): boolean {
    return this.state.isActive;
  }

  get validFrom(): Date {
    return this.state.validFrom;
  }

  get validUntil(): Date | null {
    return this.state.validUntil;
  }

  get discountRules(): DiscountRules {
    return this.state.discountRules;
  }

  get createdAt(): Date {
    return this.state.createdAt;
  }

  get updatedAt(): Date {
    return this.state.updatedAt;
  }

  // ── transitions ────────────────────────────────────────────────────────

  /**
   * Deactivate the plan. `validUntil` is set to the date-only portion of
   * `now` (UTC midnight) so the column matches the `date` type used in
   * persistence.
   */
  deactivate(now: Date): void {
    this.state.isActive = false;
    this.state.validUntil = toDateOnlyUtc(now);
    this.state.updatedAt = now;
  }
}

function toDateOnlyUtc(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
}
