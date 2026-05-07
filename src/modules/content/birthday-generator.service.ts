import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { NotificationPort } from '@/common/notifications/notification.port';
import { ChildRepository } from '@/modules/child/infrastructure/persistence/child.repository';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
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
    private readonly dataSource: DataSource,
    @Inject(ClockPort) private readonly clock: ClockPort,
  ) {}

  async runDaily(
    kindergartenId: string,
    today: Date,
  ): Promise<BirthdayGenerationResult> {
    const month = today.getUTCMonth() + 1; // 1-based
    const day = today.getUTCDate();

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
      month === 2 && day === 28 && !isLeapYear(today.getUTCFullYear())
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
      const exists = await this.contentRepo.existsBirthdayForChildOnDate(
        kindergartenId,
        childState.id,
        today,
      );
      if (exists) {
        skipped += 1;
        continue;
      }
      try {
        await this.runInTenantTx(kindergartenId, async () => {
          const post = ContentPost.createBirthday({
            id: randomUUID(),
            kindergartenId,
            targetChildId: childState.id,
            childFullName: childState.fullName,
            childAge: computeAge(childState.dateOfBirth, today),
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
            age: computeAge(childState.dateOfBirth, today),
            publishedAt: today,
          });
        });
        generated += 1;
      } catch (err) {
        this.logger.warn(
          `birthday_gen_failed kg=${kindergartenId} child=${childState.id}: ${(err as Error).message}`,
        );
      }
    }
    return { generatedCount: generated, skippedCount: skipped };
  }

  private async runInTenantTx<T>(
    kindergartenId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const ambient = tenantStorage.getStore();
    if (ambient?.entityManager) {
      return fn();
    }
    return this.dataSource.transaction(async (em) => {
      await em.query(`SELECT set_config('app.kindergarten_id', $1, true)`, [
        kindergartenId,
      ]);
      return tenantStorage.run(
        { kgId: kindergartenId, bypass: false, entityManager: em },
        () => fn(),
      );
    });
  }
}

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/**
 * Years between `dob` and `today`, decremented by 1 if today is before
 * the birth-month-day in the current year.
 */
function computeAge(dob: Date, today: Date): number {
  const tY = today.getUTCFullYear();
  const tM = today.getUTCMonth();
  const tD = today.getUTCDate();
  const bY = dob.getUTCFullYear();
  const bM = dob.getUTCMonth();
  const bD = dob.getUTCDate();
  let age = tY - bY;
  if (tM < bM || (tM === bM && tD < bD)) age -= 1;
  return age < 0 ? 0 : age;
}
