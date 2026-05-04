/**
 * EnrollmentService — service-integration suite.
 *
 * Exercises the full B5 flow against the real database:
 *   create → transition new→in_processing → update → transition →card_created
 * (which spans `enrollments`, `enrollment_status_log`, `children`, and
 * `child_guardians`). Also asserts the ambient-TX rollback contract: when an
 * inner step throws after `ChildService.createChild` already inserted, the
 * surrounding tenant TX rolls every write back atomically.
 *
 * Self-skips when `INTEGRATION_DB !== '1'` so `npm test` stays green on
 * machines without a configured tenant DB. The TX-helper here mirrors
 * `TenantContextInterceptor` exactly: open a TypeORM transaction, apply the
 * tenant GUC inside it, then run the subject body inside `tenantStorage.run`
 * with the manager pinned, so every relational repo picks up the same
 * connection (and its GUC).
 */
import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { InMemoryNotificationAdapter } from '@/common/notifications/in-memory-notification.adapter';
import { tenantStorage } from '@/database/tenant-storage';
import { OtpStorePort, StoredOtp } from '@/modules/auth/otp-store.port';
import { CameraEntity } from '@/modules/camera/infrastructure/persistence/relational/entities/camera.entity';
import { ChildService } from '@/modules/child/child.service';
import { ChildEntity } from '@/modules/child/infrastructure/persistence/relational/entities/child.entity';
import { ChildGroupHistoryEntity } from '@/modules/child/infrastructure/persistence/relational/entities/child-group-history.entity';
import { ChildGuardianEntity } from '@/modules/child/infrastructure/persistence/relational/entities/child-guardian.entity';
import { ChildGuardianRelationalRepository } from '@/modules/child/infrastructure/persistence/relational/repositories/child-guardian.repository';
import { ChildRelationalRepository } from '@/modules/child/infrastructure/persistence/relational/repositories/child.repository';
import { GroupEntity } from '@/modules/group/infrastructure/persistence/relational/entities/group.entity';
import { GroupMentorEntity } from '@/modules/group/infrastructure/persistence/relational/entities/group-mentor.entity';
import { GroupRelationalRepository } from '@/modules/group/infrastructure/persistence/relational/repositories/group.repository';
import { KindergartenEntity } from '@/modules/kindergarten/infrastructure/persistence/relational/entities/kindergarten.entity';
import { LocationEntity } from '@/modules/location/infrastructure/persistence/relational/entities/location.entity';
import { StaffMemberEntity } from '@/modules/staff/infrastructure/persistence/relational/entities/staff-member.entity';
import { StaffMemberRelationalRepository } from '@/modules/staff/infrastructure/persistence/relational/repositories/staff-member.repository';
import { UserEntity } from '@/modules/users/infrastructure/persistence/relational/entities/user.entity';
import { UserRelationalRepository } from '@/modules/users/infrastructure/persistence/relational/repositories/user.repository';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { EnrollmentEntity } from './infrastructure/persistence/relational/entities/enrollment.entity';
import { EnrollmentStatusLogEntity } from './infrastructure/persistence/relational/entities/enrollment-status-log.entity';
import { EnrollmentRelationalRepository } from './infrastructure/persistence/relational/repositories/enrollment-relational.repository';
import { EnrollmentStatusLogRelationalRepository } from './infrastructure/persistence/relational/repositories/enrollment-status-log-relational.repository';
import { EnrollmentService } from './enrollment.service';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

class FixedClock extends ClockPort {
  constructor(private readonly fixed: Date) {
    super();
  }
  now(): Date {
    return this.fixed;
  }
}

describeIntegration('EnrollmentService — service-integration', () => {
  jest.setTimeout(60_000);

  let dataSource: DataSource;
  let kgId: string;
  let userId: string;
  let staffId: string;
  let groupId: string;

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
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    kgId = randomUUID();
    userId = randomUUID();
    staffId = randomUUID();
    groupId = randomUUID();
    await dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      await m.insert(KindergartenEntity, [
        { id: kgId, name: 'KG-Service-Int', slug: `kg-svc-int-${kgId}` },
      ]);
      await m.insert(UserEntity, [
        { id: userId, phone: `+7700${kgId.slice(0, 7)}`, full_name: 'Admin' },
      ]);
      await m.insert(StaffMemberEntity, [
        {
          id: staffId,
          kindergarten_id: kgId,
          user_id: userId,
          role: 'admin',
          specialist_type: null,
          is_active: true,
        },
      ]);
      await m.insert(GroupEntity, [
        {
          id: groupId,
          kindergarten_id: kgId,
          name: 'Aralar',
          capacity: 20,
          age_range_min: 3,
          age_range_max: 5,
        },
      ]);
    });
  });

  afterEach(async () => {
    if (!dataSource.isInitialized) return;
    await dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      await m.query(
        `DELETE FROM enrollment_status_log WHERE kindergarten_id = $1`,
        [kgId],
      );
      await m.query(`DELETE FROM enrollments WHERE kindergarten_id = $1`, [
        kgId,
      ]);
      await m.query(`DELETE FROM child_guardians WHERE kindergarten_id = $1`, [
        kgId,
      ]);
      await m.query(
        `DELETE FROM child_group_history WHERE kindergarten_id = $1`,
        [kgId],
      );
      await m.query(`DELETE FROM children WHERE kindergarten_id = $1`, [kgId]);
      await m.query(`DELETE FROM groups WHERE kindergarten_id = $1`, [groupId]);
      await m.query(`DELETE FROM staff_members WHERE id = $1`, [staffId]);
      await m.query(`DELETE FROM users WHERE id = $1`, [userId]);
      await m.query(`DELETE FROM kindergartens WHERE id = $1`, [kgId]);
    });
  });

  /**
   * Recreate the runtime surface that `TenantContextInterceptor` builds for
   * each HTTP request: open a TX, apply the tenant GUC inside it, then run
   * the subject body with `tenantStorage` set to `{ kgId, bypass:false,
   * entityManager }`. Repositories pick the EntityManager up via the same
   * store, so RLS engages exactly as it would in production.
   */
  async function runScoped<T>(
    targetKgId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    return await dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.kindergarten_id = '${targetKgId}'`);
      return await tenantStorage.run(
        { kgId: targetKgId, bypass: false, entityManager: m },
        fn,
      );
    });
  }

  function makeChildService(): ChildService {
    const childRepo = new ChildRelationalRepository(
      dataSource.getRepository(ChildEntity),
      dataSource,
    );
    const guardianRepo = new ChildGuardianRelationalRepository(
      dataSource.getRepository(ChildGuardianEntity),
      dataSource,
    );
    const groupRepo = new GroupRelationalRepository(
      dataSource.getRepository(GroupEntity),
      dataSource,
    );
    const staffRepo = new StaffMemberRelationalRepository(
      dataSource.getRepository(StaffMemberEntity),
    );
    const userRepo = new UserRelationalRepository(
      dataSource.getRepository(UserEntity),
    );
    const notification = new InMemoryNotificationAdapter();
    const clock = new FixedClock(new Date('2026-04-30T10:00:00.000Z'));
    // Stub OTP store + config — only `linkChildByIin` reads them, and this
    // suite never calls that path. Defaults match `auth.config.ts`.
    const otpStore = new (class extends OtpStorePort {
      checkRateLimit(): Promise<'ok' | 'exceeded'> {
        return Promise.resolve('ok');
      }
      checkRateLimitGeneric(): Promise<'ok' | 'exceeded'> {
        return Promise.resolve('ok');
      }
      isLocked(): Promise<boolean> {
        return Promise.resolve(false);
      }
      storeCode(): Promise<void> {
        return Promise.resolve();
      }
      readCode(): Promise<StoredOtp | null> {
        return Promise.resolve(null);
      }
      incrementAttempts(): Promise<number> {
        return Promise.resolve(0);
      }
      lockPhone(): Promise<void> {
        return Promise.resolve();
      }
      clearCode(): Promise<void> {
        return Promise.resolve();
      }
    })();
    const configService = {
      getOrThrow: (key: string): unknown => {
        if (key === 'auth.rateLimitParentLinkLimit') return 5;
        if (key === 'auth.rateLimitParentLinkWindowSec') return 3600;
        throw new Error(`config_not_set: ${key}`);
      },
      get: (): unknown => undefined,
    } as unknown as ConfigService;
    return new ChildService(
      childRepo,
      guardianRepo,
      groupRepo,
      staffRepo,
      userRepo,
      notification,
      clock,
      dataSource,
      otpStore,
      configService,
    );
  }

  function makeService(childService: ChildService): EnrollmentService {
    const enrollmentRepo = new EnrollmentRelationalRepository(
      dataSource.getRepository(EnrollmentEntity),
    );
    const logRepo = new EnrollmentStatusLogRelationalRepository(
      dataSource.getRepository(EnrollmentStatusLogEntity),
    );
    const groupRepo = new GroupRelationalRepository(
      dataSource.getRepository(GroupEntity),
      dataSource,
    );
    const staffRepo = new StaffMemberRelationalRepository(
      dataSource.getRepository(StaffMemberEntity),
    );
    const clock = new FixedClock(new Date('2026-04-30T10:00:00.000Z'));
    return new EnrollmentService(
      enrollmentRepo,
      logRepo,
      childService,
      groupRepo,
      staffRepo,
      clock,
    );
  }

  it('creates → in_processing → updates → card_created (child + primary guardian + log)', async () => {
    const childService = makeChildService();
    const service = makeService(childService);

    // 1. create
    const created = await runScoped(kgId, () =>
      service.create(
        kgId,
        {
          contactName: 'Aigul Atayeva',
          contactPhone: '+77011112233',
        },
        userId,
      ),
    );
    expect(created.status.value).toBe('new');
    const enrollmentId = created.id;

    // 2. new → in_processing
    const moved = await runScoped(kgId, () =>
      service.transition(
        kgId,
        enrollmentId,
        { toStatus: 'in_processing' },
        userId,
      ),
    );
    expect(moved.enrollment.status.value).toBe('in_processing');
    expect(moved.child).toBeUndefined();

    // 3. update — fill the lead-side fields needed for card_created
    const updated = await runScoped(kgId, () =>
      service.update(kgId, enrollmentId, {
        childName: 'Aliya Atayeva',
        childDob: new Date('2021-08-15T00:00:00.000Z'),
      }),
    );
    expect(updated.childName).toBe('Aliya Atayeva');

    // 4. in_processing → card_created (heavy edge)
    const converted = await runScoped(kgId, () =>
      service.transition(
        kgId,
        enrollmentId,
        { toStatus: 'card_created', currentGroupId: groupId },
        userId,
      ),
    );
    expect(converted.enrollment.status.value).toBe('card_created');
    expect(converted.enrollment.childId).not.toBeNull();
    expect(converted.child).toBeDefined();

    const childId = converted.enrollment.childId!;

    // Verify everything landed in the DB
    await dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      const childRow = await m.query(
        `SELECT id, status, current_group_id, full_name FROM children WHERE id = $1`,
        [childId],
      );
      expect(childRow).toHaveLength(1);
      expect(childRow[0].status).toBe('card_created');
      expect(childRow[0].current_group_id).toBe(groupId);
      expect(childRow[0].full_name).toBe('Aliya Atayeva');

      const guardianRow = await m.query(
        `SELECT role, status, can_pickup
           FROM child_guardians
          WHERE child_id = $1`,
        [childId],
      );
      expect(guardianRow).toHaveLength(1);
      expect(guardianRow[0].role).toBe('primary');
      expect(guardianRow[0].status).toBe('pending_approval');
      expect(guardianRow[0].can_pickup).toBe(true);

      const logRows = await m.query(
        `SELECT from_status, to_status FROM enrollment_status_log
          WHERE enrollment_id = $1
          ORDER BY created_at ASC`,
        [enrollmentId],
      );
      expect(logRows).toHaveLength(2);
      expect(logRows[0].from_status).toBe('new');
      expect(logRows[0].to_status).toBe('in_processing');
      expect(logRows[1].from_status).toBe('in_processing');
      expect(logRows[1].to_status).toBe('card_created');
    });
  });

  it('rolls back atomically when ChildService.inviteGuardian throws after createChild', async () => {
    // Wire a ChildService whose inviteGuardian deliberately fails AFTER the
    // children row has been inserted. createChild stays real so we genuinely
    // hit the rollback boundary — it's `inviteGuardian` that throws inside
    // the same ambient TX that just performed the children INSERT, and the
    // expectation is that Postgres + TypeORM unwind everything.
    const realChild = makeChildService();
    const failingChildService: ChildService = Object.assign(
      Object.create(Object.getPrototypeOf(realChild) as object) as ChildService,
      realChild,
    );
    (
      failingChildService as { inviteGuardian: ChildService['inviteGuardian'] }
    ).inviteGuardian = () =>
      Promise.reject(new Error('synthetic-invite-guardian-failure'));

    const service = makeService(failingChildService);

    const created = await runScoped(kgId, () =>
      service.create(
        kgId,
        {
          contactName: 'Aigul Atayeva',
          contactPhone: '+77011112233',
          childName: 'Aliya Atayeva',
          childDob: new Date('2021-08-15T00:00:00.000Z'),
        },
        userId,
      ),
    );
    await runScoped(kgId, () =>
      service.transition(
        kgId,
        created.id,
        { toStatus: 'in_processing' },
        userId,
      ),
    );

    // Trigger card_created — should explode at inviteGuardian. Whole TX
    // rolls back.
    let caught: unknown = null;
    try {
      await runScoped(kgId, () =>
        service.transition(
          kgId,
          created.id,
          { toStatus: 'card_created', currentGroupId: groupId },
          userId,
        ),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('synthetic-invite-guardian-failure');

    // Verify rollback: enrollment is still in_processing, no child row, no
    // card_created log entry.
    await dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      const enrollmentRow = await m.query(
        `SELECT status, child_id FROM enrollments WHERE id = $1`,
        [created.id],
      );
      expect(enrollmentRow).toHaveLength(1);
      expect(enrollmentRow[0].status).toBe('in_processing');
      expect(enrollmentRow[0].child_id).toBeNull();

      const childRows = await m.query(
        `SELECT id FROM children WHERE kindergarten_id = $1`,
        [kgId],
      );
      expect(childRows).toHaveLength(0);

      const logRows = await m.query(
        `SELECT to_status FROM enrollment_status_log
          WHERE enrollment_id = $1`,
        [created.id],
      );
      // Only the new→in_processing entry from the prior successful transition.
      expect(logRows).toHaveLength(1);
      expect(logRows[0].to_status).toBe('in_processing');
    });
  });
});
