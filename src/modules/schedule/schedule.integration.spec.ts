/**
 * B7 Schedule — cross-tenant phantom-row isolation. Mirrors the P5 / B5
 * pattern: under `SET LOCAL app.kindergarten_id = '<KG-A>'`, KG-B's rows in
 * each of the three RLS-scoped schedule tables (`schedule_templates`,
 * `activity_events`, `schedule_week_snapshots`) are invisible. Slot
 * isolation is exercised through the parent — when the template is hidden
 * by RLS, its slots must not leak through.
 *
 * Self-skips when `INTEGRATION_DB !== '1'` so `npm test` stays green on
 * machines without a configured tenant DB.
 */
import 'reflect-metadata';
import { defer, lastValueFrom } from 'rxjs';
import { DataSource, QueryFailedError } from 'typeorm';
import { ExecutionContext } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { TenantContextInterceptor } from '@/common/interceptors/tenant-context.interceptor';
import { ChildEntity } from '@/modules/child/infrastructure/persistence/relational/entities/child.entity';
import { ChildGroupHistoryEntity } from '@/modules/child/infrastructure/persistence/relational/entities/child-group-history.entity';
import { ChildGuardianEntity } from '@/modules/child/infrastructure/persistence/relational/entities/child-guardian.entity';
import { CameraEntity } from '@/modules/camera/infrastructure/persistence/relational/entities/camera.entity';
import { GroupEntity } from '@/modules/group/infrastructure/persistence/relational/entities/group.entity';
import { GroupMentorEntity } from '@/modules/group/infrastructure/persistence/relational/entities/group-mentor.entity';
import { KindergartenEntity } from '@/modules/kindergarten/infrastructure/persistence/relational/entities/kindergarten.entity';
import { LocationEntity } from '@/modules/location/infrastructure/persistence/relational/entities/location.entity';
import { StaffMemberEntity } from '@/modules/staff/infrastructure/persistence/relational/entities/staff-member.entity';
import { UserEntity } from '@/modules/users/infrastructure/persistence/relational/entities/user.entity';
import { ActivityEvent } from './domain/entities/activity-event.entity';
import { ScheduleTemplate } from './domain/entities/schedule-template.entity';
import { ScheduleWeekSnapshot } from './domain/entities/schedule-week-snapshot.entity';
import { ActivityEventEntity } from './infrastructure/persistence/relational/entities/activity-event.entity';
import { ScheduleTemplateEntity } from './infrastructure/persistence/relational/entities/schedule-template.entity';
import { ScheduleTemplateSlotEntity } from './infrastructure/persistence/relational/entities/schedule-template-slot.entity';
import { ScheduleWeekSnapshotEntity } from './infrastructure/persistence/relational/entities/schedule-week-snapshot.entity';
import { ActivityEventRelationalRepository } from './infrastructure/persistence/relational/repositories/activity-event-relational.repository';
import { ScheduleTemplateRelationalRepository } from './infrastructure/persistence/relational/repositories/schedule-template-relational.repository';
import { ScheduleWeekSnapshotRelationalRepository } from './infrastructure/persistence/relational/repositories/schedule-week-snapshot-relational.repository';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

interface PgError {
  code?: string;
}

const FIXED_CLOCK = new Date('2026-04-30T10:00:00.000Z');
const fixedClock = { now: () => FIXED_CLOCK };

describeIntegration(
  'Schedule (B7) — cross-tenant phantom-row isolation',
  () => {
    jest.setTimeout(60_000);

    let dataSource: DataSource;
    let kgA: string;
    let kgB: string;
    let groupA: string;
    let groupB: string;
    let templateA: string;
    let templateB: string;
    let slotA: string;
    let slotB: string;
    let eventA: string;
    let eventB: string;
    let snapA: string;
    let snapB: string;

    beforeAll(async () => {
      dataSource = new DataSource({
        type: 'postgres',
        host: process.env.DATABASE_HOST ?? 'localhost',
        port: process.env.DATABASE_PORT
          ? parseInt(process.env.DATABASE_PORT, 10)
          : 5432,
        username: process.env.DATABASE_USERNAME ?? 'shyraq',
        password: process.env.DATABASE_PASSWORD ?? 'shyraq',
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
      slotA = randomUUID();
      slotB = randomUUID();
      eventA = randomUUID();
      eventB = randomUUID();
      snapA = randomUUID();
      snapB = randomUUID();

      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.insert(KindergartenEntity, [
          { id: kgA, name: 'KG-A', slug: `kg-a-sched-${kgA}` },
          { id: kgB, name: 'KG-B', slug: `kg-b-sched-${kgB}` },
        ]);
        await m.insert(GroupEntity, [
          {
            id: groupA,
            kindergarten_id: kgA,
            name: 'Aralar',
            capacity: 20,
            age_range_min: 3,
            age_range_max: 5,
          },
          {
            id: groupB,
            kindergarten_id: kgB,
            name: 'Beibar',
            capacity: 20,
            age_range_min: 3,
            age_range_max: 5,
          },
        ]);
        await m.insert(ScheduleTemplateEntity, [
          {
            id: templateA,
            kindergarten_id: kgA,
            group_id: groupA,
            name: 'A',
            recurrence: 'weekly',
            is_active: true,
            valid_from: '2026-04-01',
            valid_until: null,
          },
          {
            id: templateB,
            kindergarten_id: kgB,
            group_id: groupB,
            name: 'B',
            recurrence: 'weekly',
            is_active: true,
            valid_from: '2026-04-01',
            valid_until: null,
          },
        ]);
        await m.insert(ScheduleTemplateSlotEntity, [
          {
            id: slotA,
            template_id: templateA,
            day_of_week: 'mon',
            start_time: '09:00:00',
            end_time: '09:45:00',
            activity_name: 'A-Slot',
            location_id: null,
            description: null,
          },
          {
            id: slotB,
            template_id: templateB,
            day_of_week: 'mon',
            start_time: '09:00:00',
            end_time: '09:45:00',
            activity_name: 'B-Slot',
            location_id: null,
            description: null,
          },
        ]);
        await m.insert(ActivityEventEntity, [
          {
            id: eventA,
            kindergarten_id: kgA,
            group_id: groupA,
            template_slot_id: null,
            activity_name: 'A-Event',
            location_id: null,
            starts_at: FIXED_CLOCK,
            ends_at: null,
            status: 'scheduled',
            created_by: null,
            notes: null,
            created_at: FIXED_CLOCK,
            updated_at: FIXED_CLOCK,
          },
          {
            id: eventB,
            kindergarten_id: kgB,
            group_id: groupB,
            template_slot_id: null,
            activity_name: 'B-Event',
            location_id: null,
            starts_at: FIXED_CLOCK,
            ends_at: null,
            status: 'scheduled',
            created_by: null,
            notes: null,
            created_at: FIXED_CLOCK,
            updated_at: FIXED_CLOCK,
          },
        ]);
        await m.insert(ScheduleWeekSnapshotEntity, [
          {
            id: snapA,
            kindergarten_id: kgA,
            group_id: groupA,
            week_start_date: '2026-05-04',
            source: 'manual',
            copied_from: null,
          },
          {
            id: snapB,
            kindergarten_id: kgB,
            group_id: groupB,
            week_start_date: '2026-05-04',
            source: 'manual',
            copied_from: null,
          },
        ]);
      });
    });

    afterAll(async () => {
      if (!dataSource?.isInitialized) return;
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
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

    function makeCtx(req: Record<string, unknown>): ExecutionContext {
      return {
        getType: () => 'http',
        switchToHttp: () => ({ getRequest: () => req }),
      } as unknown as ExecutionContext;
    }

    /**
     * Recreate the runtime surface that `TenantContextInterceptor` builds for
     * each HTTP request — open a TX, apply the tenant GUC inside it, push the
     * EntityManager into `tenantStorage`. The relational repos picks the
     * manager up from the same store, so RLS engages exactly as in production.
     */
    async function runScoped<T>(
      tenant: { kgId: string | null; bypass: boolean },
      fn: () => Promise<T>,
    ): Promise<T> {
      const interceptor = new TenantContextInterceptor(dataSource);
      const next = { handle: () => defer(async () => fn()) };
      return (await lastValueFrom(
        interceptor.intercept(makeCtx({ tenant }), next),
      )) as T;
    }

    function makeTemplateRepo(): ScheduleTemplateRelationalRepository {
      return new ScheduleTemplateRelationalRepository(
        dataSource.getRepository(ScheduleTemplateEntity),
      );
    }

    function makeEventRepo(): ActivityEventRelationalRepository {
      return new ActivityEventRelationalRepository(
        dataSource.getRepository(ActivityEventEntity),
      );
    }

    function makeSnapshotRepo(): ScheduleWeekSnapshotRelationalRepository {
      return new ScheduleWeekSnapshotRelationalRepository(
        dataSource.getRepository(ScheduleWeekSnapshotEntity),
      );
    }

    // ── schedule_templates ─────────────────────────────────────────────────

    describe('schedule_templates', () => {
      it('findById: KG-A scope returns only KG-A row (with its slots)', async () => {
        const repo = makeTemplateRepo();
        const found = await runScoped(
          { kgId: kgA, bypass: false },
          async () => await repo.findById(kgA, templateA),
        );
        expect(found).not.toBeNull();
        expect(found!.id).toBe(templateA);
        expect(found!.slots).toHaveLength(1);
        expect(found!.slots[0].activityName).toBe('A-Slot');
        // Raw insert omitted `category` → DB default 'activity' round-trips.
        expect(found!.slots[0].category).toBe('activity');
      });

      it('findById: KG-B scope cannot see KG-A row', async () => {
        const repo = makeTemplateRepo();
        const found = await runScoped(
          { kgId: kgB, bypass: false },
          async () => await repo.findById(kgB, templateA),
        );
        expect(found).toBeNull();
      });

      it('list: KG-A scope returns only KG-A templates', async () => {
        const repo = makeTemplateRepo();
        const items = await runScoped(
          { kgId: kgA, bypass: false },
          async () => await repo.list(kgA, {}),
        );
        const ids = items.map((t) => t.id);
        expect(ids).toContain(templateA);
        expect(ids).not.toContain(templateB);
      });

      it('create: WITH CHECK rejects insert with kindergarten_id mismatching the GUC', async () => {
        const repo = makeTemplateRepo();
        const stranger = ScheduleTemplate.createNew(
          {
            id: randomUUID(),
            kindergartenId: kgB,
            groupId: null,
            name: 'Stranger',
            validFrom: new Date('2026-04-01'),
          },
          fixedClock,
        );
        let caught: unknown = null;
        try {
          await runScoped(
            { kgId: kgA, bypass: false },
            async () => await repo.create(kgB, stranger),
          );
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(QueryFailedError);
        const pg = (caught as QueryFailedError).driverError as PgError;
        expect(['42501', '23514']).toContain(pg.code);
      });

      it('list: bypass=true exposes both tenants', async () => {
        const repo = makeTemplateRepo();
        const result = await runScoped(
          { kgId: null, bypass: true },
          async () => {
            const a = await repo.findById(kgA, templateA);
            const b = await repo.findById(kgB, templateB);
            return { a, b };
          },
        );
        expect(result.a).not.toBeNull();
        expect(result.b).not.toBeNull();
      });
    });

    // ── activity_events ────────────────────────────────────────────────────

    describe('activity_events', () => {
      it('findById: KG-A scope cannot see KG-B event even with the id', async () => {
        const repo = makeEventRepo();
        const found = await runScoped(
          { kgId: kgA, bypass: false },
          async () => await repo.findById(kgA, eventB),
        );
        expect(found).toBeNull();
      });

      it('list: KG-A scope returns only KG-A events', async () => {
        const repo = makeEventRepo();
        const items = await runScoped(
          { kgId: kgA, bypass: false },
          async () => await repo.list(kgA, {}),
        );
        const ids = items.map((e) => e.id);
        expect(ids).toContain(eventA);
        expect(ids).not.toContain(eventB);
      });

      it('create: WITH CHECK rejects cross-tenant insert', async () => {
        const repo = makeEventRepo();
        const stranger = ActivityEvent.createScheduled(
          {
            id: randomUUID(),
            kindergartenId: kgB,
            groupId: groupB,
            origin: 'adhoc',
            activityName: 'Strange',
            startsAt: new Date('2026-05-04T10:00:00.000Z'),
          },
          fixedClock,
        );
        let caught: unknown = null;
        try {
          await runScoped(
            { kgId: kgA, bypass: false },
            async () => await repo.create(kgB, stranger),
          );
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(QueryFailedError);
        const pg = (caught as QueryFailedError).driverError as PgError;
        expect(['42501', '23514']).toContain(pg.code);
      });
    });

    // ── schedule_week_snapshots ────────────────────────────────────────────

    describe('schedule_week_snapshots', () => {
      it('findByGroupAndWeek: KG-A scope cannot see KG-B snapshot', async () => {
        const repo = makeSnapshotRepo();
        const found = await runScoped(
          { kgId: kgA, bypass: false },
          async () =>
            await repo.findByGroupAndWeek(
              kgA,
              groupB,
              new Date('2026-05-04T00:00:00.000Z'),
            ),
        );
        expect(found).toBeNull();
      });

      it('list: KG-A scope returns only KG-A snapshots', async () => {
        const repo = makeSnapshotRepo();
        const items = await runScoped(
          { kgId: kgA, bypass: false },
          async () => await repo.list(kgA, {}),
        );
        const ids = items.map((s) => s.id);
        expect(ids).toContain(snapA);
        expect(ids).not.toContain(snapB);
      });

      it('create: WITH CHECK rejects cross-tenant insert', async () => {
        const repo = makeSnapshotRepo();
        const stranger = ScheduleWeekSnapshot.createNew(
          {
            id: randomUUID(),
            kindergartenId: kgB,
            groupId: groupB,
            weekStartDate: new Date('2026-05-11T00:00:00.000Z'),
            source: 'manual',
          },
          FIXED_CLOCK,
        );
        let caught: unknown = null;
        try {
          await runScoped(
            { kgId: kgA, bypass: false },
            async () => await repo.create(kgB, stranger),
          );
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(QueryFailedError);
        const pg = (caught as QueryFailedError).driverError as PgError;
        expect(['42501', '23514']).toContain(pg.code);
      });
    });
  },
);
