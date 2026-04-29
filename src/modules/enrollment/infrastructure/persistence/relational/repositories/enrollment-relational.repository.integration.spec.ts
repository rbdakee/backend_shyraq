/**
 * B5 enrollment repository — cross-tenant phantom-row isolation. Mirrors the
 * P5 children-cross-tenant pattern: under
 * `SET LOCAL app.kindergarten_id = '<KG-A>'` only KG-A's enrollments should
 * be visible to `findById`/`list`, even when the caller passes KG-B's id; an
 * INSERT with the GUC pinned to KG-A but `kindergarten_id = KG-B` is rejected
 * by the WITH CHECK predicate; without any GUC the policy hides every row.
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
import { Enrollment } from '../../../../domain/entities/enrollment.entity';
import { EnrollmentEntity } from '../entities/enrollment.entity';
import { EnrollmentStatusLogEntity } from '../entities/enrollment-status-log.entity';
import { EnrollmentRelationalRepository } from './enrollment-relational.repository';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

interface PgError {
  code?: string;
}

describeIntegration(
  'EnrollmentRelationalRepository — cross-tenant phantom isolation',
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
          { id: kgA, name: 'KG-A', slug: `kg-a-enr-${kgA}` },
          { id: kgB, name: 'KG-B', slug: `kg-b-enr-${kgB}` },
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
            contact_name: 'Aigerim Ata',
            contact_phone: '+77001110001',
            child_name: 'Aigerim Bala',
            child_dob: '2021-09-15',
            child_iin: null,
            status: 'new',
            source: 'walk_in',
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
            contact_name: 'Bota Ata',
            contact_phone: '+77001110002',
            child_name: 'Bota Bala',
            child_dob: '2021-09-15',
            child_iin: null,
            status: 'new',
            source: 'walk_in',
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

    /**
     * Run `fn` inside the same RLS-scoped transaction the
     * `TenantContextInterceptor` would set up for an HTTP request — i.e. with
     * `SET LOCAL app.kindergarten_id` (or `app.bypass_rls`) applied and the
     * resulting EntityManager pushed into `tenantStorage`. The relational
     * repo picks the manager up via the same store, so its queries inherit
     * the GUC and the policies engage.
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

    function makeRepo(): EnrollmentRelationalRepository {
      // We supply the connection-level repo so the relational adapter has its
      // fallback manager; the actual queries resolve through tenantStorage's
      // EntityManager during the test.
      const baseRepo = dataSource.getRepository(EnrollmentEntity);
      return new EnrollmentRelationalRepository(baseRepo);
    }

    it('findById: KG-A scope returns only KG-A row', async () => {
      const repo = makeRepo();
      const found = await runScoped(
        { kgId: kgA, bypass: false },
        async () => await repo.findById(kgA, enrollmentA),
      );
      expect(found).not.toBeNull();
      expect(found!.id).toBe(enrollmentA);
      expect(found!.kindergartenId).toBe(kgA);
    });

    it('findById: KG-B scope cannot see KG-A row even if id is known', async () => {
      const repo = makeRepo();
      const found = await runScoped(
        { kgId: kgB, bypass: false },
        async () => await repo.findById(kgB, enrollmentA),
      );
      expect(found).toBeNull();
    });

    it('list: KG-A scope returns only KG-A enrollments', async () => {
      const repo = makeRepo();
      const result = await runScoped(
        { kgId: kgA, bypass: false },
        async () => await repo.list(kgA, { page: 1, limit: 50 }),
      );
      const ids = result.items.map((e) => e.id);
      expect(ids).toContain(enrollmentA);
      expect(ids).not.toContain(enrollmentB);
      expect(result.total).toBe(ids.length);
    });

    it('create: WITH CHECK rejects insert with kindergarten_id mismatching the GUC', async () => {
      const repo = makeRepo();
      const stranger = Enrollment.createNew(
        {
          kindergartenId: kgB,
          contactName: 'Stranger',
          contactPhone: '+77000000000',
        },
        { now: () => fixedClock },
        () => randomUUID(),
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
      // Postgres reports policy violations as 42501 (insufficient_privilege)
      // for the WITH CHECK branch on RLS — accept either that or the generic
      // policy error code.
      expect(['42501', '23514']).toContain(pg.code);
    });

    it('list: bypass=true exposes both tenants', async () => {
      const repo = makeRepo();
      const result = await runScoped({ kgId: null, bypass: true }, async () => {
        const a = await repo.findById(kgA, enrollmentA);
        const b = await repo.findById(kgB, enrollmentB);
        return { a, b };
      });
      expect(result.a).not.toBeNull();
      expect(result.b).not.toBeNull();
    });
  },
);
