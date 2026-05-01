import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { KindergartenRepository } from '@/modules/kindergarten/infrastructure/persistence/kindergarten.repository';
import { MealService } from '@/modules/meal/meal.service';
import { ScheduleService } from '@/modules/schedule/schedule.service';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';

/**
 * Per-kindergarten line item in the rollout summary. Carries both the
 * schedule and meal totals plus an optional error message — when non-null,
 * the rollout encountered a problem for this kg but proceeded with the rest
 * of the batch (the cron's batch must be best-effort).
 */
export interface RolloutKindergartenItem {
  kindergartenId: string;
  name: string;
  schedule: {
    copiedGroups: number;
    skippedGroups: number;
    totalEvents: number;
  };
  meal: { plansCreated: number; plansSkipped: number };
  error: string | null;
}

export interface RolloutTotals {
  kindergartens: number;
  copiedGroups: number;
  skippedGroups: number;
  totalEvents: number;
  plansCreated: number;
  plansSkipped: number;
  errors: number;
}

export interface RolloutSummary {
  fromMonday: string;
  source: 'manual' | 'cron';
  kindergartens: RolloutKindergartenItem[];
  totals: RolloutTotals;
}

export interface RunWeeklyRolloutInput {
  /**
   * Source-week Monday. The service interprets this in UTC. The cron
   * computes the previous-Monday relative to Asia/Almaty before calling.
   */
  fromMonday: Date;
  source: 'manual' | 'cron';
}

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * WeeklyRolloutService — orchestrates the schedule + meal weekly auto-copy
 * for ALL active kindergartens (T5 in B7).
 *
 * Cron path lives in `WeeklyRolloutProcessor` (BullMQ, worker process); this
 * service is the single entrypoint shared by the worker job and the admin
 * manual-trigger endpoint.
 *
 * RLS context (Variant A from the T5 brief):
 *   The cron handler runs OUTSIDE the HTTP pipeline, so neither
 *   `KindergartenScopeGuard` nor `TenantContextInterceptor` ever fire.
 *   Therefore this service drives the tenant scope itself: for each kg in
 *   the active list it opens its OWN transaction, issues
 *   `SET LOCAL app.kindergarten_id = '<kgId>'`, then runs the underlying
 *   `ScheduleService.copyWeekToNext` + `MealService.copyWeekMenuToNext`
 *   inside `tenantStorage.run({...})`. The injected
 *   `KindergartenRepository.listActive()` is itself called inside an
 *   outer `bypass=true` transaction so RLS does not hide cross-tenant
 *   rows from the cron's directory scan.
 *
 * Idempotency:
 *   Both `copyWeekToNext` and `copyWeekMenuToNext` are already idempotent —
 *   they probe for existing snapshots / plans and skip. The cron's
 *   contract is therefore "safe to re-run" so a manual trigger after a
 *   cron run is a no-op.
 *
 * Failure isolation:
 *   A failure within one kindergarten's transaction is caught, its message
 *   pinned to that kg's summary entry, and the rollout proceeds to the
 *   next kg. The whole batch never aborts on a single-kg failure.
 *
 * B9 T6: the recurring cron driver lives in the worker process now
 * (`WeeklyRolloutProcessor` on the BullMQ `schedule-rollout` queue). The
 * api process still calls this service directly from the manual-trigger
 * admin endpoint — both paths converge on `runWeeklyRollout` so the
 * orchestration logic exists in exactly one place.
 */
@Injectable()
export class WeeklyRolloutService {
  private readonly logger = new Logger(WeeklyRolloutService.name);

  constructor(
    private readonly scheduleService: ScheduleService,
    private readonly mealService: MealService,
    private readonly kindergartens: KindergartenRepository,
    @Inject(ClockPort) private readonly clock: ClockPort,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async runWeeklyRollout(
    input: RunWeeklyRolloutInput,
  ): Promise<RolloutSummary> {
    const fromMonday = startOfUtcDay(input.fromMonday);
    const fromMondayStr = fromMonday.toISOString().slice(0, 10);

    // Step 1: directory scan under bypass_rls so the cron sees every active
    // kg even though the runtime app role is NOBYPASSRLS.
    const active = await this.dataSource.transaction(async (manager) => {
      await manager.query(`SET LOCAL app.bypass_rls = 'true'`);
      return tenantStorage.run(
        { kgId: null, bypass: true, entityManager: manager },
        () => this.kindergartens.listActive(),
      );
    });

    this.logger.log(
      `weekly-rollout: source=${input.source} fromMonday=${fromMondayStr} active_kindergartens=${active.length}`,
    );

    const items: RolloutKindergartenItem[] = [];
    const totals: RolloutTotals = {
      kindergartens: active.length,
      copiedGroups: 0,
      skippedGroups: 0,
      totalEvents: 0,
      plansCreated: 0,
      plansSkipped: 0,
      errors: 0,
    };

    for (const kg of active) {
      const kgId = kg.id;
      if (!UUID_RE.test(kgId)) {
        // Defensive: malformed kg id from DB shouldn't bring the cron down.
        this.logger.warn(
          `weekly-rollout: skipping kg=${kgId} with malformed UUID`,
        );
        items.push({
          kindergartenId: kgId,
          name: kg.name,
          schedule: { copiedGroups: 0, skippedGroups: 0, totalEvents: 0 },
          meal: { plansCreated: 0, plansSkipped: 0 },
          error: 'malformed_kindergarten_id',
        });
        totals.errors += 1;
        continue;
      }

      const item: RolloutKindergartenItem = {
        kindergartenId: kgId,
        name: kg.name,
        schedule: { copiedGroups: 0, skippedGroups: 0, totalEvents: 0 },
        meal: { plansCreated: 0, plansSkipped: 0 },
        error: null,
      };

      try {
        await this.dataSource.transaction(async (manager) => {
          await manager.query(`SET LOCAL app.kindergarten_id = '${kgId}'`);
          await tenantStorage.run(
            { kgId, bypass: false, entityManager: manager },
            async () => {
              const sched = await this.scheduleService.copyWeekToNext(
                kgId,
                fromMonday,
                input.source,
              );
              item.schedule = {
                copiedGroups: sched.copiedGroups,
                skippedGroups: sched.skippedGroups,
                totalEvents: sched.totalEvents,
              };
              const meal = await this.mealService.copyWeekMenuToNext(
                kgId,
                fromMonday,
                input.source,
              );
              item.meal = {
                plansCreated: meal.plans_created,
                plansSkipped: meal.plans_skipped,
              };
            },
          );
        });
        // Only accumulate on success. If schedule succeeded but meal threw,
        // the surrounding TX rolled back both — `item.schedule` was a local
        // mutation that does NOT reflect what landed in PG, so adding it to
        // totals would over-count rows that no longer exist.
        totals.copiedGroups += item.schedule.copiedGroups;
        totals.skippedGroups += item.schedule.skippedGroups;
        totals.totalEvents += item.schedule.totalEvents;
        totals.plansCreated += item.meal.plansCreated;
        totals.plansSkipped += item.meal.plansSkipped;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `weekly-rollout: kg=${kgId} failed (${msg}); continuing with the rest`,
        );
        // Reset per-kg counters: the in-flight mutations of `item.schedule`
        // / `item.meal` were rolled back with the TX.
        item.schedule = { copiedGroups: 0, skippedGroups: 0, totalEvents: 0 };
        item.meal = { plansCreated: 0, plansSkipped: 0 };
        item.error = msg;
        totals.errors += 1;
      }

      items.push(item);
    }

    this.logger.log(
      `weekly-rollout: done source=${input.source} kindergartens=${totals.kindergartens} copiedGroups=${totals.copiedGroups} skippedGroups=${totals.skippedGroups} totalEvents=${totals.totalEvents} plansCreated=${totals.plansCreated} plansSkipped=${totals.plansSkipped} errors=${totals.errors}`,
    );

    return {
      fromMonday: fromMondayStr,
      source: input.source,
      kindergartens: items,
      totals,
    };
  }

  /**
   * Compute "previous Monday" (Mon=1 … Sun=7) for the cron driver. The
   * input `now` is interpreted in Asia/Almaty (UTC+5, no DST), and the
   * resulting Monday is returned at 00:00:00 UTC of the corresponding ISO
   * date so it interoperates with the schedule snapshot's `weekStartDate`
   * (DATE column, treated as UTC midnight). Exposed for the cron + tests.
   */
  computePreviousMonday(now: Date): Date {
    return computePreviousMonday(now);
  }
}

const ALMATY_OFFSET_MIN = 5 * 60; // UTC+5, no DST in KZ since 2005.
const DAY_MS = 24 * 60 * 60 * 1000;

function startOfUtcDay(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0),
  );
}

/**
 * Returns the Monday of the ISO week that is currently *ending* relative
 * to `now`, interpreted in Asia/Almaty (UTC+5, no DST). The cron fires Sun
 * 23:00 Almaty — at that moment the *current* Almaty ISO week (Mon..Sun)
 * is the one that's just finishing, so its Monday is the source-week
 * Monday. Pure JS — `date-fns` / `luxon` are not currently in the
 * dependency tree and the calculation is trivial enough to keep here.
 *
 * Algorithm:
 *   1. Shift `now` into Almaty wall-clock by adding 5 hours.
 *   2. Compute its ISO weekday in that shifted clock (Mon=1 … Sun=7).
 *   3. Snap to Monday of the *current* Almaty week (subtract weekday-1 days).
 *   4. Return that date as 00:00 UTC — the snapshot date is a DATE column
 *      with no timezone, and `combineDateAndTime` in ScheduleService also
 *      operates in UTC.
 *
 * Manual triggers fired *during* the week (admin operator running it on a
 * Wednesday morning, say) get the same answer: the source-week Monday is
 * always the Monday the operator already lived through. The downstream
 * `copyWeekToNext` / `copyWeekMenuToNext` are idempotent, so re-running on
 * a Wed for the same Monday is a no-op.
 */
function computePreviousMonday(now: Date): Date {
  const almaty = new Date(now.getTime() + ALMATY_OFFSET_MIN * 60 * 1000);
  const isoDay = ((almaty.getUTCDay() + 6) % 7) + 1; // Mon=1 … Sun=7
  const almatyMidnight = Date.UTC(
    almaty.getUTCFullYear(),
    almaty.getUTCMonth(),
    almaty.getUTCDate(),
    0,
    0,
    0,
    0,
  );
  const currentMonday = almatyMidnight - (isoDay - 1) * DAY_MS;
  return new Date(currentMonday);
}
