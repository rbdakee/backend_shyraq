import { Inject, Injectable, Logger } from '@nestjs/common';
import { ChildRepository } from '@/modules/child/infrastructure/persistence/child.repository';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import {
  ConditionsRoot,
  DiscountCondition,
  LeafCondition,
} from './domain/discount-conditions/conditions-evaluator';
import { CustomDiscount } from './domain/entities/custom-discount.entity';
import { CustomDiscountSnapshot } from './infrastructure/discount-engine/discount-engine.port';
import { TariffAssignmentRepository } from './infrastructure/persistence/tariff-assignment.repository';

/**
 * DiscountTargetResolver — resolves a `CustomDiscount`'s targeting mode +
 * condition tree into the concrete set of child ids it applies to.
 *
 * Used in two places:
 *   1. `CustomDiscountService.activate` → resolves recipients for the
 *      `discount.activated` outbox event.
 *   2. `InvoiceService.generateInvoice*` → filters the kg's pre-loaded
 *      active discounts down to those whose target set includes the
 *      child being billed (avoids loading all discounts × all children
 *      into the engine).
 *
 * Targeting modes:
 *   - `all`           → every non-archived child in the kg
 *   - `groups`        → children whose current_group_id ∈ targetIds
 *   - `children`      → children whose id ∈ targetIds (filtered to
 *                       in-kg + non-archived)
 *   - `tariff_types`  → children with an active tariff_assignment to a
 *                       plan in conditions.tariff_types (or, if absent,
 *                       targetIds)
 *   - `age_range`     → children whose ageInMonths ∈ conditions.age_range
 *
 * `age_range` and `tariff_types` derive from the `conditions` AST rather
 * than `targetIds`. If the matching condition is missing, the resolver
 * logs a warning and returns an empty set (defensive — admin
 * misconfiguration shouldn't 500 the activation flow).
 */
@Injectable()
export class DiscountTargetResolver {
  private readonly logger = new Logger(DiscountTargetResolver.name);

  constructor(
    private readonly childRepo: ChildRepository,
    private readonly tariffAssignments: TariffAssignmentRepository,
    @Inject(ClockPort) private readonly clock: ClockPort,
  ) {}

  /**
   * Returns the resolved set of child IDs for the discount's
   * targeting+conditions tree. Set semantics — duplicates in source
   * arrays collapse.
   */
  async resolveTargetChildIds(
    kindergartenId: string,
    discount: CustomDiscount,
  ): Promise<Set<string>> {
    const ids = await this.resolveIdList(kindergartenId, discount);
    return new Set(ids);
  }

  /**
   * Filters a list of pre-loaded `CustomDiscountSnapshot`s down to the
   * subset whose target set includes `childId`. Used by `InvoiceService`
   * before passing the list to `DiscountEnginePort.evaluate` — keeps
   * the engine pure (no repo deps) and lets the service cache the
   * lookups.
   */
  async filterDiscountsForChild(
    kindergartenId: string,
    childId: string,
    snapshots: CustomDiscountSnapshot[],
  ): Promise<CustomDiscountSnapshot[]> {
    if (snapshots.length === 0) return [];
    const out: CustomDiscountSnapshot[] = [];
    for (const snap of snapshots) {
      const targetSet = await this.resolveSnapshotTargetIds(
        kindergartenId,
        snap,
      );
      if (targetSet.has(childId)) {
        out.push(snap);
      }
    }
    return out;
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async resolveIdList(
    kindergartenId: string,
    discount: CustomDiscount,
  ): Promise<string[]> {
    return this.resolveByTargetType(kindergartenId, {
      targetType: discount.targetType,
      targetIds: discount.targetIds,
      conditions: discount.conditions,
    });
  }

  private async resolveSnapshotTargetIds(
    kindergartenId: string,
    snap: CustomDiscountSnapshot,
  ): Promise<Set<string>> {
    const ids = await this.resolveByTargetType(kindergartenId, {
      targetType: snap.targetType,
      targetIds: snap.targetIds,
      conditions: snap.conditions,
    });
    return new Set(ids);
  }

  private async resolveByTargetType(
    kindergartenId: string,
    args: {
      targetType: string;
      targetIds: string[] | null;
      conditions: ConditionsRoot;
    },
  ): Promise<string[]> {
    switch (args.targetType) {
      case 'all':
        return this.childRepo.listAllActiveIdsByKg(kindergartenId);
      case 'groups':
        return this.childRepo.listActiveIdsByGroupIds(
          kindergartenId,
          args.targetIds ?? [],
        );
      case 'children':
        return this.childRepo.findActiveIdsInKg(
          kindergartenId,
          args.targetIds ?? [],
        );
      case 'tariff_types': {
        const planIds = this.extractTariffPlanIds(
          args.conditions,
          args.targetIds,
        );
        if (planIds.length === 0) {
          this.logger.warn(
            `discount target=tariff_types but no plan ids resolved (kg=${kindergartenId})`,
          );
          return [];
        }
        return this.tariffAssignments.listActiveChildIdsByTariffPlanIds(
          kindergartenId,
          planIds,
          this.clock.now(),
        );
      }
      case 'age_range': {
        const range = this.extractAgeRange(args.conditions);
        if (range === null) {
          this.logger.warn(
            `discount target=age_range but no age_range condition found (kg=${kindergartenId})`,
          );
          return [];
        }
        return this.childRepo.listActiveIdsInKgInAgeRange(
          kindergartenId,
          range.fromMonths,
          range.toMonths,
          this.clock.now(),
        );
      }
      default:
        this.logger.warn(
          `discount unknown target_type='${args.targetType}' (kg=${kindergartenId}) — empty target set`,
        );
        return [];
    }
  }

  /**
   * Pulls `tariff_types` plan IDs from conditions: walks the AST looking
   * for any `tariff_types` leaf and unions all `in` arrays. Falls back
   * to `targetIds` when conditions don't expose a `tariff_types` filter
   * (admin used the targeting field as a UX shorthand).
   *
   * NB: the `tariff_types` condition leaf carries `InvoiceTypeCode[]`
   * (e.g. `['monthly', 'late_pickup_fee']`), NOT tariff_plan UUIDs. So
   * an in-conditions filter does NOT directly produce plan ids — it
   * filters by INVOICE TYPE. For the resolver's purpose (find children
   * eligible for a discount targeted at a class of plans) we treat
   * `targetIds` as the canonical plan-id source. The conditions leaf
   * is left for the engine's per-invoice eligibility check.
   */
  private extractTariffPlanIds(
    _conditions: ConditionsRoot,
    targetIds: string[] | null,
  ): string[] {
    return targetIds ?? [];
  }

  private extractAgeRange(
    conditions: ConditionsRoot,
  ): { fromMonths: number; toMonths: number } | null {
    return walkForAgeRange(conditions);
  }
}

/**
 * Recursively walks the conditions AST looking for the first `age_range`
 * leaf. Returns its bounds. Depth limit matches the evaluator (3 levels
 * — root counts as 0).
 */
function walkForAgeRange(
  node: unknown,
  depth = 0,
): { fromMonths: number; toMonths: number } | null {
  if (depth > 3) return null;
  if (typeof node !== 'object' || node === null) return null;
  if ('all_of' in node && Array.isArray((node as { all_of: unknown }).all_of)) {
    for (const c of (node as { all_of: DiscountCondition[] }).all_of) {
      const found = walkForAgeRange(c, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if ('any_of' in node && Array.isArray((node as { any_of: unknown }).any_of)) {
    for (const c of (node as { any_of: DiscountCondition[] }).any_of) {
      const found = walkForAgeRange(c, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const leaf = node as LeafCondition;
  if (leaf.type === 'age_range') {
    return { fromMonths: leaf.from_months, toMonths: leaf.to_months };
  }
  return null;
}
