import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ChildNotFoundError } from '@/modules/child/domain/errors/child-not-found.error';
import { ChildRepository } from '@/modules/child/infrastructure/persistence/child.repository';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { MealItem } from './domain/entities/meal-item.entity';
import {
  MealPlan,
  MealPlanSource,
  UpdateMealPlanPatch,
} from './domain/entities/meal-plan.entity';
import { InvalidDateRangeError } from './domain/errors/invalid-date-range.error';
import { MealPlanNotFoundError } from './domain/errors/meal-plan-not-found.error';
import { MealPlanRepository } from './infrastructure/persistence/meal-plan.repository';
import {
  CopyWeekSummaryDto,
  MealMenuDayDto,
  MealMenuWeekResponseDto,
} from './dto/meal-plan.response.dto';
import { GroupNotFoundError } from '@/modules/group/domain/errors/group-not-found.error';
import { GroupRepository } from '@/modules/group/infrastructure/persistence/group.repository';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Add `days` to the UTC midnight of `d` and return a new Date at UTC midnight. */
function addDaysUtc(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS);
}

/** Format a Date as ISO date (YYYY-MM-DD), interpreting the underlying UTC instant. */
function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Parse an ISO date string (YYYY-MM-DD) as a Date at 00:00:00 UTC. */
function parseIsoDateUtc(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

export interface CreateMealPlanInput {
  date: string;
  groupId?: string | null;
  isPublished?: boolean;
  notes?: { ru: string; kk?: string; en?: string } | null;
  source?: MealPlanSource;
  copiedFrom?: string | null;
  createdBy?: string | null;
  items?: CreateMealItemServiceInput[];
}

export interface CreateMealItemServiceInput {
  mealType: string;
  dishName: { ru: string; kk?: string; en?: string };
  description?: { ru: string; kk?: string; en?: string } | null;
  allergens?: string[] | null;
  photoUrl?: string | null;
  calories?: number | null;
  serveTime?: string | null;
  position?: number;
}

export interface UpdateMealPlanInput {
  isPublished?: boolean;
  notes?: { ru: string; kk?: string; en?: string } | null;
}

export interface UpdateMealItemInput {
  mealType?: string;
  dishName?: { ru: string; kk?: string; en?: string };
  description?: { ru: string; kk?: string; en?: string } | null;
  allergens?: string[] | null;
  photoUrl?: string | null;
  calories?: number | null;
  serveTime?: string | null;
  position?: number;
}

export interface ListMealPlansInput {
  dateFrom: string;
  dateTo: string;
  groupId?: string | null;
}

/**
 * MealService — business logic for meal_plans + meal_items (B7).
 *
 * First arg of every business method is `kindergartenId` (explicit intent,
 * IDE-navigation). No direct TypeORM/Repository imports — only injected ports.
 */
@Injectable()
export class MealService {
  constructor(
    private readonly mealPlanRepo: MealPlanRepository,
    private readonly groupRepo: GroupRepository,
    private readonly childRepo: ChildRepository,
    @Inject(ClockPort) private readonly clock: ClockPort,
  ) {}

  // ── Plans ────────────────────────────────────────────────────────────────

  async createPlan(
    kindergartenId: string,
    input: CreateMealPlanInput,
    callerStaffId?: string,
  ): Promise<MealPlan> {
    if (input.groupId) {
      const group = await this.groupRepo.findById(
        kindergartenId,
        input.groupId,
      );
      if (!group) throw new GroupNotFoundError(input.groupId);
    }

    const now = this.clock.now();
    const planId = randomUUID();

    const plan = MealPlan.create({
      id: planId,
      kindergartenId,
      date: input.date,
      groupId: input.groupId ?? null,
      isPublished: input.isPublished ?? true,
      notes: input.notes ?? null,
      source: input.source ?? 'manual',
      copiedFrom: input.copiedFrom ?? null,
      createdBy: callerStaffId ?? input.createdBy ?? null,
      now,
      items: (input.items ?? []).map((i) => ({
        id: randomUUID(),
        mealPlanId: planId,
        mealType: i.mealType as MealItem['mealType'],
        dishName: i.dishName,
        description: i.description,
        allergens: i.allergens,
        photoUrl: i.photoUrl,
        calories: i.calories,
        serveTime: i.serveTime,
        position: i.position,
      })),
    });

    return this.mealPlanRepo.create(kindergartenId, plan);
  }

  async getPlan(kindergartenId: string, planId: string): Promise<MealPlan> {
    const plan = await this.mealPlanRepo.findById(kindergartenId, planId);
    if (!plan) throw new MealPlanNotFoundError(planId);
    return plan;
  }

  async listPlans(
    kindergartenId: string,
    input: ListMealPlansInput,
  ): Promise<MealPlan[]> {
    if (input.dateFrom > input.dateTo) {
      throw new InvalidDateRangeError(input.dateFrom, input.dateTo);
    }
    return this.mealPlanRepo.list(kindergartenId, {
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      groupId: input.groupId,
    });
  }

  async updatePlan(
    kindergartenId: string,
    planId: string,
    input: UpdateMealPlanInput,
  ): Promise<MealPlan> {
    const plan = await this.mealPlanRepo.findById(kindergartenId, planId);
    if (!plan) throw new MealPlanNotFoundError(planId);

    const patch: UpdateMealPlanPatch = {};
    if (input.isPublished !== undefined) patch.isPublished = input.isPublished;
    if (input.notes !== undefined) patch.notes = input.notes;
    plan.applyPatch(patch, this.clock.now());

    return this.mealPlanRepo.update(kindergartenId, plan);
  }

  async deletePlan(kindergartenId: string, planId: string): Promise<void> {
    const plan = await this.mealPlanRepo.findById(kindergartenId, planId);
    if (!plan) throw new MealPlanNotFoundError(planId);
    await this.mealPlanRepo.delete(kindergartenId, planId);
  }

  // ── Items ────────────────────────────────────────────────────────────────

  async addItem(
    kindergartenId: string,
    planId: string,
    input: CreateMealItemServiceInput,
  ): Promise<MealPlan> {
    const plan = await this.mealPlanRepo.findById(kindergartenId, planId);
    if (!plan) throw new MealPlanNotFoundError(planId);

    const now = this.clock.now();
    plan.addItem(
      {
        id: randomUUID(),
        mealType: input.mealType as MealItem['mealType'],
        dishName: input.dishName,
        description: input.description,
        allergens: input.allergens,
        photoUrl: input.photoUrl,
        calories: input.calories,
        serveTime: input.serveTime,
        position: input.position,
      },
      now,
    );

    return this.mealPlanRepo.addItem(planId, plan);
  }

  async updateItem(
    kindergartenId: string,
    planId: string,
    itemId: string,
    input: UpdateMealItemInput,
  ): Promise<MealPlan> {
    const plan = await this.mealPlanRepo.findById(kindergartenId, planId);
    if (!plan) throw new MealPlanNotFoundError(planId);

    plan.updateItem(
      itemId,
      {
        mealType: input.mealType as MealItem['mealType'] | undefined,
        dishName: input.dishName,
        description: input.description,
        allergens: input.allergens,
        photoUrl: input.photoUrl,
        calories: input.calories,
        serveTime: input.serveTime,
        position: input.position,
      },
      this.clock.now(),
    );

    return this.mealPlanRepo.updateItem(planId, plan);
  }

  async removeItem(
    kindergartenId: string,
    planId: string,
    itemId: string,
  ): Promise<void> {
    const plan = await this.mealPlanRepo.findById(kindergartenId, planId);
    if (!plan) throw new MealPlanNotFoundError(planId);

    // Throws MealItemNotFoundError if not found
    plan.removeItem(itemId, this.clock.now());

    await this.mealPlanRepo.removeItem(planId, itemId, plan);
  }

  // ── Parent menu ──────────────────────────────────────────────────────────

  /**
   * Returns a week's menu for a child. Resolves child → group_id, then
   * fetches plans where group_id = child.group_id OR group_id IS NULL (kg-wide),
   * only is_published=true.
   *
   * Group-specific plan takes precedence over kg-wide for the same date
   * (the parent sees the group-specific one).
   */
  async getMenuForChild(
    kindergartenId: string,
    childId: string,
    weekStart: string,
  ): Promise<MealMenuWeekResponseDto> {
    const child = await this.childRepo.findById(kindergartenId, childId);
    if (!child) throw new ChildNotFoundError(childId);

    const groupId = child.currentGroupId ?? null;

    const plans = await this.mealPlanRepo.listForWeek(
      kindergartenId,
      weekStart,
      groupId,
    );

    // Build a map: date → group-specific plan (preferred) or kg-wide plan
    const dayMap = new Map<string, MealPlan>();
    for (const plan of plans) {
      const existing = dayMap.get(plan.date);
      if (!existing) {
        dayMap.set(plan.date, plan);
      } else if (plan.groupId !== null) {
        // group-specific overrides kg-wide
        dayMap.set(plan.date, plan);
      }
    }

    // Build 7-day response. UTC arithmetic — host TZ must not affect the
    // mapping from ISO date string back into a date offset.
    const days: MealMenuDayDto[] = [];
    const start = parseIsoDateUtc(weekStart);
    for (let i = 0; i < 7; i++) {
      const d = addDaysUtc(start, i);
      const dateStr = toIsoDate(d);
      const plan = dayMap.get(dateStr) ?? null;
      days.push({
        date: dateStr,
        plan: plan
          ? {
              id: plan.id,
              date: plan.date,
              group_id: plan.groupId,
              is_published: plan.isPublished,
              notes: plan.notes,
              source: plan.source,
              copied_from: plan.copiedFrom,
              items: plan.items.map((item) => ({
                id: item.id,
                meal_type: item.mealType,
                dish_name: item.dishName,
                description: item.description,
                allergens: item.allergens,
                photo_url: item.photoUrl,
                calories: item.calories,
                serve_time: item.serveTime,
                position: item.position,
              })),
              created_at: plan.createdAt.toISOString(),
              updated_at: plan.updatedAt.toISOString(),
            }
          : null,
      });
    }

    return { week_start: weekStart, days };
  }

  // ── Copy week ────────────────────────────────────────────────────────────

  /**
   * Copies all meal_plans in [fromMonday, fromMonday+7) to [nextMonday, nextMonday+7).
   *
   * Idempotent at `(date, group_id)` granularity: we read the slots already
   * occupied in the target week and drop only the source plans that collide,
   * copying the rest. `batchCreate` therefore never sees a conflicting row,
   * so a 23505 can never poison the ambient transaction.
   *
   * Granularity matters operationally: the previous implementation probed
   * "does ANY plan exist anywhere in the target week for this kg", which meant
   * one pre-created day — a draft, an empty plan, a Sat/Sun entry — silently
   * blocked the whole week's auto-copy (`plans_created: 0`). Kindergartens
   * routinely pre-create something, so the cron was a no-op for them. The
   * schedule half of the weekly rollout already skips per-group; this matches.
   *
   * Called by T5 cron and by admin manual trigger.
   */
  async copyWeekMenuToNext(
    kindergartenId: string,
    fromMonday: Date,
    source: 'manual' | 'cron',
  ): Promise<CopyWeekSummaryDto> {
    // UTC arithmetic — host TZ must not influence the from→to range.
    const fromStart = toIsoDate(fromMonday);
    const fromEndStr = toIsoDate(addDaysUtc(fromMonday, 6));
    const targetMonday = addDaysUtc(fromMonday, 7);
    const targetSundayStr = toIsoDate(addDaysUtc(targetMonday, 6));
    const targetMondayStr = toIsoDate(targetMonday);

    // Per-(kg, target-week) advisory lock. Serializes concurrent callers
    // (cron + admin manual trigger, two admin clicks) on the SAME target
    // week so the occupied-slot probe below observes the first caller's
    // just-committed plans and filters them out, instead of racing into
    // batchCreate where a 23505 would poison the ambient TX. Lock is
    // auto-released when the ambient TX commits/rolls back.
    await this.mealPlanRepo.acquireWeekCopyLock(
      kindergartenId,
      targetMondayStr,
    );

    const sourcePlans = await this.mealPlanRepo.list(kindergartenId, {
      dateFrom: fromStart,
      dateTo: fromEndStr,
    });

    if (sourcePlans.length === 0) {
      return { plans_created: 0, plans_skipped: 0 };
    }

    // Idempotency probe — resolve conflicts BEFORE any insert. If we let
    // `batchCreate` race and rely on its 23505 catch-and-continue, the first
    // 23505 inside the ambient TX puts it into the failed (25P02) state and
    // every subsequent statement raises InFailedSqlTransactionError, which
    // would propagate as a 500.
    const occupied = await this.mealPlanRepo.listOccupiedSlotsInRange(
      kindergartenId,
      targetMondayStr,
      targetSundayStr,
    );
    const occupiedKeys = new Set(
      occupied.map((slot) => slotKey(slot.date, slot.groupId)),
    );

    // Project each source plan onto its target date, then keep only the ones
    // whose slot is free. `plans_skipped` is now the count of genuinely
    // conflicting days, not "the whole week because one day existed".
    const projected = sourcePlans.map((src) => ({
      src,
      // src.date is YYYY-MM-DD — parse as UTC and add exactly 7 UTC days.
      targetDateStr: toIsoDate(addDaysUtc(parseIsoDateUtc(src.date), 7)),
    }));
    const copyable = projected.filter(
      (p) => !occupiedKeys.has(slotKey(p.targetDateStr, p.src.groupId)),
    );
    const plansSkipped = projected.length - copyable.length;

    if (copyable.length === 0) {
      return { plans_created: 0, plans_skipped: plansSkipped };
    }

    const now = this.clock.now();
    const newPlans: MealPlan[] = copyable.map(({ src, targetDateStr }) => {
      const newPlanId = randomUUID();

      return MealPlan.create({
        id: newPlanId,
        kindergartenId,
        date: targetDateStr,
        groupId: src.groupId,
        isPublished: src.isPublished,
        notes: src.notes,
        source: source === 'cron' ? 'cron' : 'copied',
        copiedFrom: src.id,
        createdBy: src.createdBy,
        now,
        items: src.items.map((item) => ({
          id: randomUUID(),
          mealPlanId: newPlanId,
          mealType: item.mealType,
          dishName: item.dishName,
          description: item.description,
          allergens: item.allergens,
          photoUrl: item.photoUrl,
          calories: item.calories,
          serveTime: item.serveTime,
          position: item.position,
        })),
      });
    });

    const result = await this.mealPlanRepo.batchCreate(
      kindergartenId,
      newPlans,
    );
    return {
      plans_created: result.plans_created,
      // `result.plans_skipped` should be 0 — the probe above already removed
      // every conflicting slot — but add it anyway so a row lost to the
      // defensive 23505 net still shows up in the summary.
      plans_skipped: plansSkipped + result.plans_skipped,
    };
  }
}

/**
 * Key for the `(date, group_id)` uniqueness pair. `group_id IS NULL` means a
 * kindergarten-wide plan and is a distinct slot from any group plan on the
 * same date — matching the two partial-unique indexes on `meal_plans`. The
 * `*` sentinel cannot collide with a groupId (always a UUID).
 */
function slotKey(date: string, groupId: string | null): string {
  return `${date}|${groupId ?? '*'}`;
}
