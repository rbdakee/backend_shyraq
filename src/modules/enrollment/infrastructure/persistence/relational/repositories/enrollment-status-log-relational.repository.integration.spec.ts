/**
 * B5 enrollment_status_log repository — cross-tenant phantom-row isolation.
 * Mirrors the enrollment-relational integration spec; here the table under
 * test is the append-only audit log. Asserts that:
 *   - `append` succeeds when GUC matches the log row's kindergarten_id;
 *   - `listForEnrollment` under KG-B scope cannot see a KG-A enrollment's
 *     log rows;
 *   - bypass=true exposes both tenants' rows.
 *
 * Self-skips when `INTEGRATION_DB !== '1'`.
 */
import 'reflect-metadata';
import { defer, lastValueFrom } from 'rxjs';
import { DataSource } from 'typeorm';
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
import { EnrollmentEntity } from '../entities/enrollment.entity';
import { EnrollmentStatusLogEntity } from '../entities/enrollment-status-log.entity';
import { EnrollmentStatusLogRelationalRepository } from './enrollment-status-log-relational.repository';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

describeIntegration(
  'EnrollmentStatusLogRelationalRepository — cross-tenant phantom isolation',
  () => {
    jest.setTimeout(60_000);

    let dataSource: DataSource;
    let kgA: string;
    let kgB: string;
    let userA: string;
    let userB: string;
    let staffA: string;
    let staffB: string;
    let enrollmentA: string;
    let enrollmentB: string;

    const fixedClock = new Date('2026-04-30T10:00:00.000Z');

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
          EnrollmentEntity,
          EnrollmentStatusLogEntity,
        ],
        synchronize: false,
        logging: false,
      });
      await dataSource.initialize();

      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        kgA = randomUUID();
        kgB = randomUUID();
        userA = randomUUID();
        userB = randomUUID();
        staffA = randomUUID();
        staffB = randomUUID();
        enrollmentA = randomUUID();
        enrollmentB = randomUUID();

        await m.insert(KindergartenEntity, [
          { id: kgA, name: 'KG-A', slug: `kg-a-log-${kgA}` },
          { id: kgB, name: 'KG-B', slug: `kg-b-log-${kgB}` },
        ]);
        await m.insert(UserEntity, [
          { id: userA, phone: `+7700${kgA.slice(0, 7)}`, full_name: 'A' },
          { id: userB, phone: `+7711${kgB.slice(0, 7)}`, full_name: 'B' },
        ]);
        await m.insert(StaffMemberEntity, [
          {
            id: staffA,
            kindergarten_id: kgA,
            user_id: userA,
            role: 'admin',
            specialist_type: null,
            is_active: true,
          },
          {
            id: staffB,
            kindergarten_id: kgB,
            user_id: userB,
            role: 'admin',
            specialist_type: null,
            is_active: true,
          },
        ]);
        await m.insert(EnrollmentEntity, [
          {
            id: enrollmentA,
            kindergarten_id: kgA,
            child_id: null,
            contact_name: 'A Parent',
            contact_phone: '+77001110011',
            child_name: 'A Child',
            child_dob: '2021-09-15',
            child_iin: null,
            status: 'in_processing',
            source: null,
            notes: null,
            assigned_to: staffA,
            status_changed_at: fixedClock,
            created_at: fixedClock,
            updated_at: fixedClock,
          },
          {
            id: enrollmentB,
            kindergarten_id: kgB,
            child_id: null,
            contact_name: 'B Parent',
            contact_phone: '+77001110012',
            child_name: 'B Child',
            child_dob: '2021-09-15',
            child_iin: null,
            status: 'in_processing',
            source: null,
            notes: null,
            assigned_to: staffB,
            status_changed_at: fixedClock,
            created_at: fixedClock,
            updated_at: fixedClock,
          },
        ]);
      });
    });

    afterAll(async () => {
      if (!dataSource?.isInitialized) return;
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(
          `DELETE FROM enrollment_status_log WHERE kindergarten_id IN ($1, $2)`,
          [kgA, kgB],
        );
        await m.query(
          `DELETE FROM enrollments WHERE kindergarten_id IN ($1, $2)`,
          [kgA, kgB],
        );
        await m.query(`DELETE FROM staff_members WHERE id IN ($1, $2)`, [
          staffA,
          staffB,
        ]);
        await m.query(`DELETE FROM users WHERE id IN ($1, $2)`, [userA, userB]);
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

    function makeRepo(): EnrollmentStatusLogRelationalRepository {
      const baseRepo = dataSource.getRepository(EnrollmentStatusLogEntity);
      return new EnrollmentStatusLogRelationalRepository(baseRepo);
    }

    it('append: writes a log row visible inside the same tenant scope', async () => {
      const repo = makeRepo();
      const persisted = await runScoped(
        { kgId: kgA, bypass: false },
        async () =>
          repo.append(kgA, {
            enrollmentId: enrollmentA,
            kindergartenId: kgA,
            fromStatus: 'new',
            toStatus: 'in_processing',
            changedBy: staffA,
            comment: null,
            createdAt: fixedClock,
          }),
      );
      expect(persisted.id).toBeDefined();
      expect(persisted.kindergartenId).toBe(kgA);
      expect(persisted.toStatus).toBe('in_processing');

      // Read it back through the same tenant scope.
      const rows = await runScoped({ kgId: kgA, bypass: false }, async () =>
        repo.listForEnrollment(kgA, enrollmentA),
      );
      expect(rows.find((r) => r.id === persisted.id)).toBeDefined();
    });

    it('listForEnrollment: KG-B scope cannot see KG-A enrollment log rows', async () => {
      const repo = makeRepo();

      // Seed a KG-A log row first under bypass.
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.insert(EnrollmentStatusLogEntity, {
          id: randomUUID(),
          enrollment_id: enrollmentA,
          kindergarten_id: kgA,
          from_status: 'in_processing',
          to_status: 'waitlist',
          changed_by: staffA,
          comment: null,
          created_at: fixedClock,
        });
      });

      const rows = await runScoped({ kgId: kgB, bypass: false }, async () =>
        repo.listForEnrollment(kgB, enrollmentA),
      );
      expect(rows).toHaveLength(0);
    });

    it('listForEnrollment: bypass=true exposes both tenants', async () => {
      const repo = makeRepo();
      // Seed one log row in each kg under bypass to make sure both exist.
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.insert(EnrollmentStatusLogEntity, [
          {
            id: randomUUID(),
            enrollment_id: enrollmentA,
            kindergarten_id: kgA,
            from_status: 'in_processing',
            to_status: 'cancelled',
            changed_by: staffA,
            comment: null,
            created_at: fixedClock,
          },
          {
            id: randomUUID(),
            enrollment_id: enrollmentB,
            kindergarten_id: kgB,
            from_status: 'in_processing',
            to_status: 'cancelled',
            changed_by: staffB,
            comment: null,
            created_at: fixedClock,
          },
        ]);
      });

      const aRows = await runScoped({ kgId: null, bypass: true }, async () =>
        repo.listForEnrollment(kgA, enrollmentA),
      );
      const bRows = await runScoped({ kgId: null, bypass: true }, async () =>
        repo.listForEnrollment(kgB, enrollmentB),
      );
      expect(aRows.length).toBeGreaterThan(0);
      expect(bRows.length).toBeGreaterThan(0);
    });
  },
);
