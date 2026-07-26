import { MealPlan } from '../../domain/entities/meal-plan.entity';

export interface ListMealPlansFilter {
  dateFrom: string;
  dateTo: string;
  groupId?: string | null;
}

/**
 * Port (abstract class) over the `meal_plans` + `meal_items` tables.
 * The service layer always passes `kindergartenId` explicitly — RLS is
 * defense-in-depth, not the contract boundary.
 *
 * All methods return domain objects (`MealPlan`), never TypeORM entities.
 */
export abstract class MealPlanRepository {
  /** Insert a new meal_plan row. Throws MealPlanAlreadyExistsError on 23505. */
  abstract create(kindergartenId: string, plan: MealPlan): Promise<MealPlan>;

  /** Find a plan (with all its items) by id within a tenant. */
  abstract findById(
    kindergartenId: string,
    planId: string,
  ): Promise<MealPlan | null>;

  /** List plans within a date range, optionally filtered by groupId. */
  abstract list(
    kindergartenId: string,
    filter: ListMealPlansFilter,
  ): Promise<MealPlan[]>;

  /** Update plan-level fields. Does NOT touch items (items are updated separately). */
  abstract update(kindergartenId: string, plan: MealPlan): Promise<MealPlan>;

  /** Delete the plan and all its items (CASCADE). */
  abstract delete(kindergartenId: string, planId: string): Promise<void>;

  // ── item operations ──────────────────────────────────────────────────────

  /** Append a new meal_item row for the given plan. */
  abstract addItem(planId: string, plan: MealPlan): Promise<MealPlan>;

  /** Persist item-level field changes. */
  abstract updateItem(planId: string, plan: MealPlan): Promise<MealPlan>;

  /** Delete one meal_item row. */
  abstract removeItem(
    planId: string,
    itemId: string,
    plan: MealPlan,
  ): Promise<MealPlan>;

  /**
   * List published plans for a given week (7 days starting from weekStart)
   * where group_id matches OR group_id IS NULL (kg-wide), used by parent
   * menu endpoint. Returns only is_published=true plans.
   */
  abstract listForWeek(
    kindergartenId: string,
    weekStart: string,
    groupId: string | null,
  ): Promise<MealPlan[]>;

  /**
   * List the `(date, group_id)` slots already occupied by a plan in
   * `[dateFrom, dateTo]`. Used by `copyWeekMenuToNext` as its idempotency
   * probe: the returned pairs are exactly the keys of the two partial-unique
   * indexes (`idx_meal_plans_unique_group` for group_id IS NOT NULL,
   * `idx_meal_plans_unique_kg` for group_id IS NULL), so a source plan whose
   * projected slot is absent from this set is guaranteed insertable.
   *
   * Deliberately NOT a whole-week boolean: a kindergarten that pre-created a
   * single day (or a Saturday plan, or a draft) would otherwise block the
   * copy of the entire target week. Slot-level granularity mirrors the
   * schedule side, which already skips per-group.
   */
  abstract listOccupiedSlotsInRange(
    kindergartenId: string,
    dateFrom: string,
    dateTo: string,
  ): Promise<Array<{ date: string; groupId: string | null }>>;

  /**
   * Batch-insert plans for copy-week. Returns count of actually inserted rows
   * (skips on 23505 conflict — idempotent).
   */
  abstract batchCreate(
    kindergartenId: string,
    plans: MealPlan[],
  ): Promise<{ plans_created: number; plans_skipped: number }>;

  /**
   * Acquire a per-(kg, week) advisory lock to serialize concurrent
   * `copyWeekMenuToNext` callers (cron + admin manual trigger, two admin
   * clicks). Released at the surrounding TX boundary.
   *
   * Without the lock, two callers can both observe the same empty slot set
   * in the race window, both enter `batchCreate`, the loser's INSERT hits
   * 23505 → PG sets the TX state to 25P02 (InFailedSqlTransactionError)
   * which poisons every subsequent statement in the ambient TX.
   */
  abstract acquireWeekCopyLock(
    kindergartenId: string,
    weekStartIso: string,
  ): Promise<void>;
}
