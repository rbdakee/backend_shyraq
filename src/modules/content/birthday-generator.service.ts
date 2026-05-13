import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { NotificationPort } from '@/common/notifications/notification.port';
import { ChildRepository } from '@/modules/child/infrastructure/persistence/child.repository';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { TransactionRunnerPort } from '@/shared-kernel/application/ports/transaction-runner.port';
import { formatDateInTimezone } from '@/shared-kernel/domain/value-objects/day-of-week.vo';
import { tenantStorage } from '@/database/tenant-storage';
import { ContentRepository } from './content.repository';
import { ContentPost } from './domain/entities/content-post.entity';

export interface BirthdayGenerationResult {
  generatedCount: number;
  skippedCount: number;
}

/**
 * BirthdayGeneratorService — runs the daily birthday-content cron
 * (BP §9.5). Iterates active children whose `date_of_birth`'s
 * (month, day) match `today`'s, computes age, and creates an
 * auto-published `content_type='birthday'` row plus an outbox
 * `content.birthday` event.
 *
 * Idempotency: `existsBirthdayForChildOnDate(kg, child, today)` short-
 * circuits the create path so re-running the cron the same day skips
 * already-generated posts.
 *
 * Leap-year policy: when `today` is Feb 28 in a non-leap year, we ALSO
 * generate posts for children born Feb 29. The reverse never happens —
 * Feb 29 children only need a feed entry once per year, and the only
 * non-leap calendar that lacks Feb 29 falls through to Feb 28 by this
 * code path.
 */
@Injectable()
export class BirthdayGeneratorService {
  private readonly logger = new Logger(BirthdayGeneratorService.name);

  constructor(
    private readonly contentRepo: ContentRepository,
    private readonly childRepo: ChildRepository,
    private readonly notificationPort: NotificationPort,
    @Inject(TransactionRunnerPort)
    private readonly tx: TransactionRunnerPort,
    @Inject(ClockPort) private readonly clock: ClockPort,
  ) {}

  async runDaily(
    kindergartenId: string,
    today: Date,
  ): Promise<BirthdayGenerationResult> {
    // H9: normalize `today` once at the boundary to the Asia/Almaty calendar
    // date. The cron fires at 07:00 Almaty so it is always safely inside one
    // local day, but `runDaily` is also reachable from the manual saas
    // trigger which passes arbitrary wall-clock instants. Deriving month/day
    // via `getUTCMonth/UTCDate` rolls back a day for any 19:00-24:00 UTC
    // input (= 00:00-05:00 next day Almaty).
    const todayIso = formatDateInTimezone(today); // 'YYYY-MM-DD' Almaty
    const [yearStr, monthStr, dayStr] = todayIso.split('-');
    const year = Number(yearStr);
    const month = Number(monthStr); // 1-based
    const day = Number(dayStr);

    // Primary set — children born on (month, day).
    const children = await this.childRepo.listActiveByBirthdayMonthDay(
      kindergartenId,
      month,
      day,
    );

    // Leap-year policy: in non-leap years, Feb 29 children get their post
    // on Feb 28. We DO NOT generate twice — when `today` is Feb 29 in a
    // leap year, the primary set already includes them.
    const leapYearChildren =
      month === 2 && day === 28 && !isLeapYear(year)
        ? await this.childRepo.listActiveByBirthdayMonthDay(
            kindergartenId,
            2,
            29,
          )
        : [];

    const allChildren = [...children, ...leapYearChildren];

    let generated = 0;
    let skipped = 0;
    for (const child of allChildren) {
      const childState = child.toState();
      // B17 T8 HIGH#5: cheap pre-lock probe so the common idempotent case
      // (already exists, no race) skips the lock + retry overhead. The
      // authoritative check-then-insert sequence still runs inside the
      // advisory lock to defend against concurrency.
      const existsFast = await this.contentRepo.existsBirthdayForChildOnDate(
        kindergartenId,
        childState.id,
        today,
      );
      if (existsFast) {
        skipped += 1;
        continue;
      }
      try {
        const created = await this.runInTenantTx(kindergartenId, async () => {
          // B17 T8 HIGH#5 — per-(kg, child, date) advisory lock serializes
          // concurrent runs (cron + manual saas trigger, or two ticks).
          // Held for the TX so the in-flight INSERT is visible before the
          // lock is released.
          await this.contentRepo.acquireBirthdayAdvisoryLock(
            kindergartenId,
            childState.id,
            today,
          );
          // Re-check inside the lock — the prior winner committed an
          // INSERT that we now observe.
          const exists = await this.contentRepo.existsBirthdayForChildOnDate(
            kindergartenId,
            childState.id,
            today,
          );
          if (exists) return false;
          const post = ContentPost.createBirthday({
            id: randomUUID(),
            kindergartenId,
            targetChildId: childState.id,
            childFullName: childState.fullName,
            childAge: computeAge(childState.dateOfBirth, year, month, day),
            now: today,
          });
          // Stamp full name into metadata so the dispatcher template can
          // render it without re-resolving the child row.
          const metaWithName = {
            ...(post.metadata ?? {}),
            child_full_name: childState.fullName,
          };
          const stamped = ContentPost.fromState({
            ...post.toState(),
            metadata: metaWithName,
          });
          await this.contentRepo.create(stamped);
          await this.notificationPort.notifyContentBirthday({
            kindergartenId,
            contentPostId: stamped.id,
            targetChildId: childState.id,
            childFullName: childState.fullName,
            age: computeAge(childState.dateOfBirth, year, month, day),
            publishedAt: today,
          });
          return true;
        });
        if (created) generated += 1;
        else skipped += 1;
      } catch (err) {
        // B22a T5 / B17 MEDIUM#6 — per-child SAVEPOINT already rolled
        // the failing child's INSERT + outbox emit back; the outer
        // kg-batch TX is alive and the loop continues with the next
        // child so a single render/notify failure no longer aborts the
        // whole kg's birthday generation.
        this.logger.warn(
          `birthday_gen_child_failed kg=${kindergartenId} child=${childState.id}: ${(err as Error).message}`,
        );
      }
    }
    return { generatedCount: generated, skippedCount: skipped };
  }

  /**
   * Run `fn` inside a per-child SAVEPOINT (B22a T5 / B17 MEDIUM#6). When
   * the daily-cron processor opens an outer kg-batch TX, this method
   * issues a TypeORM nested `manager.transaction(...)` — PostgreSQL
   * encodes that as `SAVEPOINT … RELEASE/ROLLBACK TO SAVEPOINT`. A
   * single-child render or notify failure rolls the savepoint back
   * without poisoning the outer kg-batch TX, so previously-committed
   * birthday posts for sibling children stay durable and the loop
   * continues.
   *
   * When called WITHOUT an ambient TX (CLI / direct invocation) we open
   * the kg-scoped outer TX ourselves; the per-child SAVEPOINT semantics
   * still apply via the inner `em.transaction(...)` call.
   */
  private async runInTenantTx<T>(
    kindergartenId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const ambient = tenantStorage.getStore();
    if (ambient?.entityManager) {
      // Inside an outer TX (e.g. cron processor) — open a SAVEPOINT and
      // re-publish the savepoint manager via `tenantStorage.run` so every
      // repository call inside `fn` (advisory lock, exists check, INSERT,
      // outbox emit) participates in the savepoint and rolls back
      // atomically on failure without aborting the kg-batch TX.
      return ambient.entityManager.transaction(async (savepointManager) => {
        return tenantStorage.run(
          {
            kgId: kindergartenId,
            bypass: ambient.bypass,
            entityManager: savepointManager,
          },
          () => fn(),
        );
      });
    }
    return this.tx.run(async (em) => {
      await em.query(`SELECT set_config('app.kindergarten_id', $1, true)`, [
        kindergartenId,
      ]);
      return tenantStorage.run(
        { kgId: kindergartenId, bypass: false, entityManager: em },
        // Per-child SAVEPOINT inside the kg-batch TX we just opened.
        () =>
          em.transaction(async (savepointManager) =>
            tenantStorage.run(
              {
                kgId: kindergartenId,
                bypass: false,
                entityManager: savepointManager,
              },
              () => fn(),
            ),
          ),
      );
    });
  }
}

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/**
 * Years between `dob` (a date-only midnight-UTC marker, OK to read via
 * `getUTC*` since the DB column is `date` not `timestamptz`) and a
 * caller-supplied Almaty-calendar (year, month1-based, day). The caller
 * normalises the wall-clock instant once at the boundary — see
 * `formatDateInTimezone` upstream — so this helper does NOT take a Date
 * for "today" anymore.
 */
function computeAge(
  dob: Date,
  todayYear: number,
  todayMonth1: number,
  todayDay: number,
): number {
  const bY = dob.getUTCFullYear();
  const bM = dob.getUTCMonth(); // 0-based
  const bD = dob.getUTCDate();
  const tM = todayMonth1 - 1; // align with bM zero-base
  let age = todayYear - bY;
  if (tM < bM || (tM === bM && todayDay < bD)) age -= 1;
  return age < 0 ? 0 : age;
}
