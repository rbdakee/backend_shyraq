import {
  TariffPlan,
  TariffType,
  TariffAppliesTo,
  DiscountRules,
} from '../../domain/entities/tariff-plan.entity';

export interface ListTariffPlansFilter {
  isActive?: boolean;
  tariffType?: TariffType;
  groupId?: string | null;
}

export interface UpdateTariffPlanPatch {
  name?: string;
  description?: Record<string, string>;
  amount?: number;
  appliesTo?: TariffAppliesTo;
  groupId?: string | null;
  ageMinMonths?: number | null;
  ageMaxMonths?: number | null;
  isActive?: boolean;
  validFrom?: Date;
  validUntil?: Date | null;
  discountRules?: DiscountRules;
}

/**
 * Persistence port for `tariff_plans`. Tenant-scoped via the ambient HTTP
 * tenant TX (RLS).
 */
export abstract class TariffPlanRepository {
  abstract create(plan: TariffPlan): Promise<TariffPlan>;

  abstract update(
    kindergartenId: string,
    id: string,
    patch: UpdateTariffPlanPatch,
    now: Date,
  ): Promise<TariffPlan | null>;

  /**
   * Persist the full domain aggregate after a state mutator (e.g.
   * `deactivate`). Saves the readable subset of `toState()` (immutable
   * fields are not re-written).
   */
  abstract save(plan: TariffPlan): Promise<TariffPlan>;

  abstract findById(
    kindergartenId: string,
    id: string,
  ): Promise<TariffPlan | null>;

  /**
   * Resolves the active plan of a given `tariffType` for the kindergarten.
   * If multiple match, the impl picks the most recently `validFrom`.
   * Returns `null` if no active plan covers `atDate` (defaults to "now").
   */
  abstract findActiveByType(
    kindergartenId: string,
    tariffType: TariffType,
    atDate?: Date,
  ): Promise<TariffPlan | null>;

  abstract list(
    kindergartenId: string,
    filter?: ListTariffPlansFilter,
  ): Promise<TariffPlan[]>;
}
