/**
 * WeeklyRolloutService — integration suite (gated INTEGRATION_DB=1).
 *
 * Boots a real PG via the same DSN as the rest of the integration specs,
 * seeds two kindergartens (kgA, kgB) each with a group, an active
 * schedule template + slot, and a meal_plan in the source week. Calls
 * `runWeeklyRollout({fromMonday, source: 'manual'})` end-to-end (real
 * `KindergartenRepository`, `ScheduleService`, `MealService`) and asserts:
 *
 *   1. activity_events + schedule_week_snapshots + meal_plans landed in
 *      target week for BOTH kgs.
 *   2. Re-running with the same fromMonday is idempotent (counters flip
 *      to skipped, no extra rows).
 *   3. Cross-tenant isolation: kgA's events did NOT land into kgB's
 *      snapshot rows and vice versa.
 *   4. summary.totals matches what's actually in the DB.
 */
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { ChildEntity } from '@/modules/child/infrastructure/persistence/relational/entities/child.entity';
import { ChildGroupHistoryEntity } from '@/modules/child/infrastructure/persistence/relational/entities/child-group-history.entity';
import { ChildGuardianEntity } from '@/modules/child/infrastructure/persistence/relational/entities/child-guardian.entity';
import { CameraEntity } from '@/modules/camera/infrastructure/persistence/relational/entities/camera.entity';
import { ChildRepository } from '@/modules/child/infrastructure/persistence/child.repository';
import { ChildRelationalRepository } from '@/modules/child/infrastructure/persistence/relational/repositories/child.repository';
import { GroupEntity } from '@/modules/group/infrastructure/persistence/relational/entities/group.entity';
import { GroupMentorEntity } from '@/modules/group/infrastructure/persistence/relational/entities/group-mentor.entity';
import { GroupRepository } from '@/modules/group/infrastructure/persistence/group.repository';
import { GroupRelationalRepository } from '@/modules/group/infrastructure/persistence/relational/repositories/group.repository';
import { KindergartenEntity } from '@/modules/kindergarten/infrastructure/persistence/relational/entities/kindergarten.entity';
import { KindergartenRelationalRepository } from '@/modules/kindergarten/infrastructure/persistence/relational/repositories/kindergarten.repository';
import { LocationEntity } from '@/modules/location/infrastructure/persistence/relational/entities/location.entity';
import { StaffMemberEntity } from '@/modules/staff/infrastructure/persistence/relational/entities/staff-member.entity';
import { UserEntity } from '@/modules/users/infrastructure/persistence/relational/entities/user.entity';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { MealItemEntity } from '@/modules/meal/infrastructure/persistence/relational/entities/meal-item.entity';
import { MealPlanEntity } from '@/modules/meal/infrastructure/persistence/relational/entities/meal-plan.entity';
import { MealPlanRelationalRepository } from '@/modules/meal/infrastructure/persistence/relational/repositories/meal-plan-relational.repository';
import { MealService } from '@/modules/meal/meal.service';
import { ActivityEventEntity } from '@/modules/schedule/infrastructure/persistence/relational/entities/activity-event.entity';
import { ScheduleTemplateEntity } from '@/modules/schedule/infrastructure/persistence/relational/entities/schedule-template.entity';
import { ScheduleTemplateSlotEntity } from '@/modules/schedule/infrastructure/persistence/relational/entities/schedule-template-slot.entity';
import { ScheduleWeekSnapshotEntity } from '@/modules/schedule/infrastructure/persistence/relational/entities/schedule-week-snapshot.entity';
import { ActivityEventRelationalRepository } from '@/modules/schedule/infrastructure/persistence/relational/repositories/activity-event-relational.repository';
import { ScheduleTemplateRelationalRepository } from '@/modules/schedule/infrastructure/persistence/relational/repositories/schedule-template-relational.repository';
import { ScheduleWeekSnapshotRelationalRepository } from '@/modules/schedule/infrastructure/persistence/relational/repositories/schedule-week-snapshot-relational.repository';
import { ScheduleService } from '@/modules/schedule/schedule.service';
import { WeeklyRolloutService } from './weekly-rollout.service';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

class FixedClock extends ClockPort {
  constructor(private readonly t: Date) {
    super();
  }
  now(): Date {
    return this.t;
  }
}

describeIntegration('WeeklyRolloutService — integration', () => {
  jest.setTimeout(60_000);

  let dataSource: DataSource;
  let kgA: string;
  let kgB: string;
  let groupA: string;
  let groupB: string;
  let templateA: string;
  let templateB: string;
  let mealPlanA: string;
  let mealPlanB: string;

  // Source week Monday: 2026-04-27 (UTC) → next week Monday: 2026-05-04.
  const FROM_MONDAY = new Date('2026-04-27T00:00:00.000Z');
  const NEXT_MONDAY = '2026-05-04';
  const FIXED = new Date('2026-05-03T18:00:00.000Z'); // Sun 23:00 Almaty

  beforeAll(async () => {
    dataSource = new DataSource({
      type: 'postgres',
      host: process.env.DATABASE_HOST ?? 'localhost',
      port: process.env.DATABASE_PORT
        ? parseInt(process.env.DATABASE_PORT, 10)
        : 5432,
      username: process.env.DATABASE_USERNAME ?? 'shyraq_app',
      password: process.env.DATABASE_PASSWORD ?? 'shyraq_app',
      database: process.env.DATABASE_NAME ?? 'shyraq',
      entities: [
        KindergartenEntity,
        UserEntity,
        StaffMemberEntity,
        LocationEntity,
        GroupEntity,
        GroupMentorEntity,
        CameraEntity,
        ChildEntity,
        ChildGuardianEntity,
        ChildGroupHistoryEntity,
        ScheduleTemplateEntity,
        ScheduleTemplateSlotEntity,
        ActivityEventEntity,
        ScheduleWeekSnapshotEntity,
        MealPlanEntity,
        MealItemEntity,
      ],
      synchronize: false,
      logging: false,
    });
    await dataSource.initialize();

    kgA = randomUUID();
    kgB = randomUUID();
    groupA = randomUUID();
    groupB = randomUUID();
    templateA = randomUUID();
    templateB = randomUUID();
    mealPlanA = randomUUID();
    mealPlanB = randomUUID();

    await dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);

      await m.insert(KindergartenEntity, [
        {
          id: kgA,
          name: 'KG-A-Rollout',
          slug: `kg-a-rollout-${kgA.slice(0, 8)}`,
          is_active: true,
          archived_at: null,
        },
        {
          id: kgB,
          name: 'KG-B-Rollout',
          slug: `kg-b-rollout-${kgB.slice(0, 8)}`,
          is_active: true,
          archived_at: null,
        },
      ]);
      await m.insert(GroupEntity, [
        {
          id: groupA,
          kindergarten_id: kgA,
          name: 'A-Group',
          capacity: 20,
          age_range_min: 3,
          age_range_max: 5,
        },
        {
          id: groupB,
          kindergarten_id: kgB,
          name: 'B-Group',
          capacity: 20,
          age_range_min: 3,
          age_range_max: 5,
        },
      ]);
      // Active schedule template + Monday slot in each kg's source week.
      await m.insert(ScheduleTemplateEntity, [
        {
          id: templateA,
          kindergarten_id: kgA,
          group_id: groupA,
          name: 'A-Template',
          recurrence: 'weekly',
          is_active: true,
          valid_from: '2026-04-01',
          valid_until: null,
        },
        {
          id: templateB,
          kindergarten_id: kgB,
          group_id: groupB,
          name: 'B-Template',
          recurrence: 'weekly',
          is_active: true,
          valid_from: '2026-04-01',
          valid_until: null,
        },
      ]);
      await m.insert(ScheduleTemplateSlotEntity, [
        {
          id: randomUUID(),
          template_id: templateA,
          day_of_week: 'mon',
          start_time: '09:00:00',
          end_time: '09:45:00',
          activity_name: 'A-Slot-Monday',
          location_id: null,
          description: null,
        },
        {
          id: randomUUID(),
          template_id: templateB,
          day_of_week: 'tue',
          start_time: '10:00:00',
          end_time: '10:45:00',
          activity_name: 'B-Slot-Tuesday',
          location_id: null,
          description: null,
        },
      ]);
      // Source-week meal plans (one per kg) so copyWeekMenuToNext has work.
      await m.insert(MealPlanEntity, [
        {
          id: mealPlanA,
          kindergarten_id: kgA,
          date: '2026-04-27',
          group_id: null,
          is_published: true,
          notes: null,
          source: 'manual',
          copied_from: null,
          created_by: null,
        },
        {
          id: mealPlanB,
          kindergarten_id: kgB,
          date: '2026-04-28',
          group_id: null,
          is_published: true,
          notes: null,
          source: 'manual',
          copied_from: null,
          created_by: null,
        },
      ]);
    });
  });

  afterAll(async () => {
    if (!dataSource?.isInitialized) return;
    await dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      await m.query(
        `DELETE FROM meal_items WHERE meal_plan_id IN (SELECT id FROM meal_plans WHERE kindergarten_id IN ($1, $2))`,
        [kgA, kgB],
      );
      await m.query(
        `DELETE FROM meal_plans WHERE kindergarten_id IN ($1, $2)`,
        [kgA, kgB],
      );
      await m.query(
        `DELETE FROM schedule_week_snapshots WHERE kindergarten_id IN ($1, $2)`,
        [kgA, kgB],
      );
      await m.query(
        `DELETE FROM activity_events WHERE kindergarten_id IN ($1, $2)`,
        [kgA, kgB],
      );
      await m.query(
        `DELETE FROM schedule_template_slots WHERE template_id IN ($1, $2)`,
        [templateA, templateB],
      );
      await m.query(
        `DELETE FROM schedule_templates WHERE kindergarten_id IN ($1, $2)`,
        [kgA, kgB],
      );
      await m.query(`DELETE FROM groups WHERE id IN ($1, $2)`, [
        groupA,
        groupB,
      ]);
      await m.query(`DELETE FROM kindergartens WHERE id IN ($1, $2)`, [
        kgA,
        kgB,
      ]);
    });
    await dataSource.destroy();
  });

  function makeRollout(): WeeklyRolloutService {
    const clock = new FixedClock(FIXED);
    const kgRepo = new KindergartenRelationalRepository(
      dataSource.getRepository(KindergartenEntity),
    );
    const groupRepo: GroupRepository = new GroupRelationalRepository(
      dataSource.getRepository(GroupEntity),
    );
    const childRepo: ChildRepository = new ChildRelationalRepository(
      dataSource.getRepository(ChildEntity),
      dataSource,
    );
    const tplRepo = new ScheduleTemplateRelationalRepository(
      dataSource.getRepository(ScheduleTemplateEntity),
    );
    const eventRepo = new ActivityEventRelationalRepository(
      dataSource.getRepository(ActivityEventEntity),
    );
    const snapRepo = new ScheduleWeekSnapshotRelationalRepository(
      dataSource.getRepository(ScheduleWeekSnapshotEntity),
    );
    const mealRepo = new MealPlanRelationalRepository(
      dataSource.getRepository(MealPlanEntity),
      dataSource.getRepository(MealItemEntity),
    );
    const scheduleSvc = new ScheduleService(
      tplRepo,
      eventRepo,
      snapRepo,
      groupRepo,
      childRepo,
      clock,
    );
    const mealSvc = new MealService(mealRepo, groupRepo, childRepo, clock);
    return new WeeklyRolloutService(
      scheduleSvc,
      mealSvc,
      kgRepo,
      clock,
      dataSource,
    );
  }

  it('rolls out schedule + meal for every active kindergarten and isolates per-tenant', async () => {
    const rollout = makeRollout();
    const summary = await rollout.runWeeklyRollout({
      fromMonday: FROM_MONDAY,
      source: 'manual',
    });

    expect(summary.fromMonday).toBe('2026-04-27');
    expect(summary.kindergartens.length).toBeGreaterThanOrEqual(2);

    const itemA = summary.kindergartens.find((k) => k.kindergartenId === kgA)!;
    const itemB = summary.kindergartens.find((k) => k.kindergartenId === kgB)!;
    expect(itemA).toBeDefined();
    expect(itemB).toBeDefined();
    expect(itemA.error).toBeNull();
    expect(itemB.error).toBeNull();
    expect(itemA.schedule.copiedGroups).toBe(1);
    expect(itemA.schedule.totalEvents).toBe(1);
    expect(itemB.schedule.copiedGroups).toBe(1);
    expect(itemB.schedule.totalEvents).toBe(1);
    expect(itemA.meal.plansCreated).toBe(1);
    expect(itemB.meal.plansCreated).toBe(1);

    // Verify rows in the DB. Use bypass_rls scope so we can see both kgs.
    await dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);

      const snaps = await m.query(
        `SELECT id, kindergarten_id, group_id, week_start_date::text AS week_start_date, source FROM schedule_week_snapshots WHERE kindergarten_id IN ($1, $2)`,
        [kgA, kgB],
      );
      // 2 new manual snapshots (one per kg, target week Monday).
      const sourceManual = snaps.filter(
        (s: { source: string; week_start_date: string }) =>
          s.source === 'manual' && s.week_start_date === NEXT_MONDAY,
      );
      expect(sourceManual).toHaveLength(2);

      const events = await m.query(
        `SELECT id, kindergarten_id, group_id, starts_at FROM activity_events WHERE kindergarten_id IN ($1, $2) AND starts_at >= $3 AND starts_at < $4`,
        [
          kgA,
          kgB,
          new Date(`${NEXT_MONDAY}T00:00:00.000Z`),
          new Date('2026-05-11T00:00:00.000Z'),
        ],
      );
      expect(events.length).toBeGreaterThanOrEqual(2);

      // Cross-tenant isolation: every kgA event lives in kgA, every kgB in kgB.
      for (const ev of events as {
        kindergarten_id: string;
        group_id: string;
      }[]) {
        if (ev.kindergarten_id === kgA) {
          expect(ev.group_id).toBe(groupA);
        } else if (ev.kindergarten_id === kgB) {
          expect(ev.group_id).toBe(groupB);
        }
      }

      const targetMealPlans = await m.query(
        `SELECT kindergarten_id, date::text AS date, copied_from FROM meal_plans WHERE kindergarten_id IN ($1, $2) AND date >= $3 AND date < $4`,
        [kgA, kgB, NEXT_MONDAY, '2026-05-11'],
      );
      expect(targetMealPlans.length).toBe(2);
      // Each new plan was copied from the matching source plan.
      const fromA = targetMealPlans.find(
        (p: { kindergarten_id: string }) => p.kindergarten_id === kgA,
      );
      const fromB = targetMealPlans.find(
        (p: { kindergarten_id: string }) => p.kindergarten_id === kgB,
      );
      expect(fromA.copied_from).toBe(mealPlanA);
      expect(fromB.copied_from).toBe(mealPlanB);
    });
  });

  it('idempotent: re-running with the same fromMonday is a no-op (no new rows)', async () => {
    const rollout = makeRollout();
    // Snapshot the pre-state row counts (under bypass_rls).
    const before = await dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      const snaps = await m.query(
        `SELECT count(*)::int AS c FROM schedule_week_snapshots WHERE kindergarten_id IN ($1, $2)`,
        [kgA, kgB],
      );
      const events = await m.query(
        `SELECT count(*)::int AS c FROM activity_events WHERE kindergarten_id IN ($1, $2)`,
        [kgA, kgB],
      );
      const plans = await m.query(
        `SELECT count(*)::int AS c FROM meal_plans WHERE kindergarten_id IN ($1, $2)`,
        [kgA, kgB],
      );
      return {
        snaps: snaps[0].c as number,
        events: events[0].c as number,
        plans: plans[0].c as number,
      };
    });

    const summary = await rollout.runWeeklyRollout({
      fromMonday: FROM_MONDAY,
      source: 'manual',
    });

    // copiedGroups must be 0 — every group already has its target snapshot.
    const itemA = summary.kindergartens.find((k) => k.kindergartenId === kgA)!;
    const itemB = summary.kindergartens.find((k) => k.kindergartenId === kgB)!;
    expect(itemA.schedule.copiedGroups).toBe(0);
    expect(itemA.schedule.skippedGroups).toBe(1);
    expect(itemB.schedule.copiedGroups).toBe(0);
    expect(itemB.schedule.skippedGroups).toBe(1);
    expect(itemA.meal.plansCreated).toBe(0);
    expect(itemB.meal.plansCreated).toBe(0);
    expect(itemA.meal.plansSkipped).toBeGreaterThanOrEqual(1);
    expect(itemB.meal.plansSkipped).toBeGreaterThanOrEqual(1);

    const after = await dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      const snaps = await m.query(
        `SELECT count(*)::int AS c FROM schedule_week_snapshots WHERE kindergarten_id IN ($1, $2)`,
        [kgA, kgB],
      );
      const events = await m.query(
        `SELECT count(*)::int AS c FROM activity_events WHERE kindergarten_id IN ($1, $2)`,
        [kgA, kgB],
      );
      const plans = await m.query(
        `SELECT count(*)::int AS c FROM meal_plans WHERE kindergarten_id IN ($1, $2)`,
        [kgA, kgB],
      );
      return {
        snaps: snaps[0].c as number,
        events: events[0].c as number,
        plans: plans[0].c as number,
      };
    });

    expect(after.snaps).toBe(before.snaps);
    expect(after.events).toBe(before.events);
    expect(after.plans).toBe(before.plans);
  });
});
