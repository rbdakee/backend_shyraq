import type { EntityManager } from '@/shared-kernel/application/ports/transaction-runner.port';
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

  /**
   * Returns `true` if there is at least one existing **active** tariff_plan
   * row in `kindergartenId` whose `valid_from..valid_until` window overlaps
   * `[validFrom, validUntil]` for the same `(tariffType, appliesTo, groupId)`
   * tuple.
   *
   * For `appliesTo='age_range'` rows the collision is broader — any other
   * `age_range` plan of the same `tariffType` with a window overlap is
   * considered a conflict (age-bound overlap detection is too expensive to do
   * here; we err on the safe side and let admins close+reopen).
   *
   * For `appliesTo='individual'` rows the method always returns `false` —
   * per-child assignments are managed via `tariff_assignments`.
   *
   * `excludeId` lets the update path skip the row currently being edited.
   *
   * Default impl returns `false` so older test fakes (B13..B22a) keep
   * compiling; the relational adapter overrides.
   */
  existsOverlap(
    _kindergartenId: string,
    _tariffType: TariffPlan['tariffType'],
    _appliesTo: TariffPlan['appliesTo'],
    _groupId: string | null,
    _validFrom: Date,
    _validUntil: Date | null,
    _excludeId?: string,
  ): Promise<boolean> {
    return Promise.resolve(false);
  }

  /**
   * B22b T15 Codex H2 — serialise overlap check+write so concurrent
   * admin `create()`/`update()` calls for the same
   * `(kg, tariffType, appliesTo, groupId/null)` cannot both pass
   * `existsOverlap()` and both insert. Acquires
   * `pg_advisory_xact_lock(hashtext('tariff-overlap:'||kg||':'||type||':'||
   * appliesTo||':'||groupId/null)::bigint)` on the open TX. The lock is
   * released at TX commit/rollback; callers must invoke this BEFORE
   * `existsOverlap()` inside a `TransactionRunnerPort.run()` block.
   *
   * Uses non-`try_` advisory lock — we want concurrent callers to BLOCK
   * (queueing), not race. Default impl is a no-op so existing test
   * fakes (B13..B22a) keep compiling; the relational adapter overrides.
   */
  acquireOverlapAdvisoryLock(
    _kindergartenId: string,
    _tariffType: TariffPlan['tariffType'],
    _appliesTo: TariffPlan['appliesTo'],
    _groupId: string | null,
    _manager?: EntityManager,
  ): Promise<void> {
    return Promise.resolve();
  }
}
