/**
 * B11 Pickup OTP — concurrent validateOtp race-integration spec.
 *
 * Self-skips when `INTEGRATION_DB !== '1'` so `npm test` stays green
 * on machines without a configured tenant DB. Run with:
 *
 *   INTEGRATION_DB=1 DATABASE_USERNAME=shyraq_app DATABASE_PASSWORD=shyraq_app \
 *   npm test -- --testPathPattern pickup.race.integration
 *
 * What this guards: two+ concurrent `validateOtp` calls for the same
 * pickup_request (e.g. two staff members on different devices, a
 * network retry) must not both succeed — i.e. must not produce two
 * checkout attendance_events. The `pg_advisory_xact_lock` keyed on
 * `requestId` serializes access so the second concurrent call waits
 * behind the first and then observes that the OTP code has been cleared
 * (first caller consumed it via `clearCode`). The second call therefore
 * receives `OtpExpiredError` rather than double-validating.
 *
 * The spec runs three concurrent `service.validateOtp(...)` calls
 * inside the same TenantContextInterceptor wiring the HTTP path uses
 * and asserts the post-condition invariants:
 *   - Exactly 1 caller fully validates (`pickupRequest.status='validated'`).
 *   - 2 callers reject with `OtpExpiredError` (code cleared by winner).
 *   - DB pickup_requests row ends up `status='validated'`.
 *   - DB attendance_events shows exactly 1 row for that pickup_request_id.
 *
 * The previous shape of this spec stubbed StaffMemberRepository and
 * AttendanceService as `null` which meant the first caller crashed at
 * the staff lookup — useful for proving the lock serialised callers but
 * not actually exercising the validate side-effect path. T7 H1 rewrite:
 * real PG-backed StaffMemberRelationalRepository + a deterministic
 * in-memory FakeAttendanceService that just stamps an attendance_events
 * row and returns its id; the OtpExpired branch then comes from the
 * shared in-memory FakePickupOtpStore (clearCode happens-before second
 * caller's readCode).
 */
import 'reflect-metadata';
import { ExecutionContext } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { defer, lastValueFrom } from 'rxjs';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { TenantContextInterceptor } from '@/common/interceptors/tenant-context.interceptor';
import { tenantStorage } from '@/database/tenant-storage';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { OtpStorePort, StoredOtp } from '@/modules/auth/otp-store.port';
import { SmsPort, SmsSendResult } from '@/modules/auth/sms.port';
import {
  NotificationPort,
  AttendanceCheckInEvent,
  AttendanceCheckOutEvent,
  ChildTransferredEvent,
  DailyStatusChangedEvent,
  GuardianApprovedEvent,
  GuardianPendingApprovalEvent,
  GuardianRejectedEvent,
  GuardianRevokedEvent,
  GuardianSelfRevokedEvent,
  PermissionsUpdatedEvent,
  PickupOtpSentEvent,
  PickupValidatedEvent,
  TimelineEntryCreatedEvent,
} from '@/common/notifications/notification.port';
import { OtpExpiredError } from '@/modules/auth/domain/errors/otp-expired.error';
import { PickupRequestAlreadyValidatedError } from '@/modules/pickup/domain/errors/pickup-request-already-validated.error';
import { ChildGuardianRepository } from '@/modules/child/infrastructure/persistence/child-guardian.repository';
import { ChildRepository } from '@/modules/child/infrastructure/persistence/child.repository';
import { KindergartenRepository } from '@/modules/kindergarten/infrastructure/persistence/kindergarten.repository';
import { StaffMemberRelationalRepository } from '@/modules/staff/infrastructure/persistence/relational/repositories/staff-member.repository';
import { StaffMemberEntity } from '@/modules/staff/infrastructure/persistence/relational/entities/staff-member.entity';
import { KindergartenEntity } from '@/modules/kindergarten/infrastructure/persistence/relational/entities/kindergarten.entity';
import { UserEntity } from '@/modules/users/infrastructure/persistence/relational/entities/user.entity';
import { AttendanceService } from '@/modules/attendance/attendance.service';
import { PickupRequestService } from '@/modules/pickup/pickup-request.service';
import {
  PickupOtpStorePort,
  StoredPickupOtp,
} from '@/modules/pickup/infrastructure/otp/pickup-otp-store.port';
import { PickupRequestRelationalRepository } from '@/modules/pickup/infrastructure/persistence/relational/repositories/pickup-request.relational.repository';
import { TrustedPersonRelationalRepository } from '@/modules/pickup/infrastructure/persistence/relational/repositories/trusted-person.relational.repository';
import { PickupRequestTypeOrmEntity } from '@/modules/pickup/infrastructure/persistence/relational/entities/pickup-request.typeorm.entity';
import { TrustedPersonTypeOrmEntity } from '@/modules/pickup/infrastructure/persistence/relational/entities/trusted-person.typeorm.entity';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

// ── Fake ports ────────────────────────────────────────────────────────────────

class FakePickupOtpStore extends PickupOtpStorePort {
  private codes = new Map<string, StoredPickupOtp>();
  private locks = new Map<string, boolean>();

  seed(requestId: string, code: string): void {
    this.codes.set(requestId, { code, attempts: 0 });
  }

  storeCode(requestId: string, code: string, _ttl: number): Promise<string> {
    const key = `otp:pickup:${requestId}`;
    this.codes.set(requestId, { code, attempts: 0 });
    return Promise.resolve(key);
  }

  readCode(requestId: string): Promise<StoredPickupOtp | null> {
    return Promise.resolve(this.codes.get(requestId) ?? null);
  }

  clearCode(requestId: string): Promise<void> {
    this.codes.delete(requestId);
    return Promise.resolve();
  }

  incrementAttempts(requestId: string): Promise<number> {
    const entry = this.codes.get(requestId);
    if (!entry) return Promise.resolve(1);
    entry.attempts += 1;
    return Promise.resolve(entry.attempts);
  }

  lockRequest(requestId: string, _ttl: number): Promise<void> {
    this.locks.set(requestId, true);
    return Promise.resolve();
  }

  isLocked(requestId: string): Promise<boolean> {
    return Promise.resolve(this.locks.get(requestId) ?? false);
  }
}

class FakeAuthOtpStore extends OtpStorePort {
  checkRateLimit(
    _phone: string,
    _limit: number,
    _windowSec: number,
  ): Promise<'ok' | 'exceeded'> {
    return Promise.resolve('ok');
  }

  isLocked(_phone: string): Promise<boolean> {
    return Promise.resolve(false);
  }

  storeCode(_phone: string, _code: string, _ttl: number): Promise<void> {
    return Promise.resolve();
  }

  readCode(_phone: string): Promise<StoredOtp | null> {
    return Promise.resolve(null);
  }

  incrementAttempts(_phone: string): Promise<number> {
    return Promise.resolve(1);
  }

  lockPhone(_phone: string, _ttl: number): Promise<void> {
    return Promise.resolve();
  }

  clearCode(_phone: string): Promise<void> {
    return Promise.resolve();
  }
}

class FakeSms extends SmsPort {
  send(_phone: string, _msg: string): Promise<SmsSendResult> {
    return Promise.resolve({ txnId: 'fake-txn' });
  }
}

class FakeNotifications extends NotificationPort {
  notifyGuardianPendingApproval(
    _e: GuardianPendingApprovalEvent,
  ): Promise<void> {
    return Promise.resolve();
  }
  notifyGuardianApproved(_e: GuardianApprovedEvent): Promise<void> {
    return Promise.resolve();
  }
  notifyGuardianRejected(_e: GuardianRejectedEvent): Promise<void> {
    return Promise.resolve();
  }
  notifyGuardianRevoked(_e: GuardianRevokedEvent): Promise<void> {
    return Promise.resolve();
  }
  notifyChildTransferred(_e: ChildTransferredEvent): Promise<void> {
    return Promise.resolve();
  }
  notifyPermissionsUpdated(_e: PermissionsUpdatedEvent): Promise<void> {
    return Promise.resolve();
  }
  notifyAttendanceCheckIn(_e: AttendanceCheckInEvent): Promise<void> {
    return Promise.resolve();
  }
  notifyAttendanceCheckOut(_e: AttendanceCheckOutEvent): Promise<void> {
    return Promise.resolve();
  }
  notifyDailyStatusChanged(_e: DailyStatusChangedEvent): Promise<void> {
    return Promise.resolve();
  }
  notifyTimelineEntryCreated(_e: TimelineEntryCreatedEvent): Promise<void> {
    return Promise.resolve();
  }
  notifyGuardianSelfRevoked(_e: GuardianSelfRevokedEvent): Promise<void> {
    return Promise.resolve();
  }
  notifyPickupOtpSent(_e: PickupOtpSentEvent): Promise<void> {
    return Promise.resolve();
  }
  notifyPickupValidated(_e: PickupValidatedEvent): Promise<void> {
    return Promise.resolve();
  }
}

class FixedClock implements ClockPort {
  constructor(private readonly d: Date) {}
  now(): Date {
    return this.d;
  }
}

/**
 * Minimal in-memory AttendanceService stand-in. The race spec only needs
 * `checkOut(...)` to return a stable `event.id` AND to write a row in
 * `attendance_events` so the post-condition assertion can count it. We
 * write the row through the supplied DataSource so it participates in
 * the ambient TX (rolls back if the surrounding service path throws).
 */
class FakeAttendanceService {
  constructor(private readonly dataSource: DataSource) {}

  async checkOut(
    kindergartenId: string,
    childId: string,
    callerUserId: string,
    _pickupUserId: string | null,
    opts: {
      method?: { value: string };
      pickupRequestId?: string | null;
      recordedAt?: Date;
    } = {},
  ): Promise<{ event: { id: string } }> {
    const eventId = randomUUID();
    const now = opts.recordedAt ?? new Date();
    // Resolve the staff_member_id for the caller (`recorded_by` FK on
    // attendance_events). Use the ambient TX manager so we participate
    // in the surrounding service TX — and we DON'T bypass RLS because
    // the manager has the right GUC set already by the interceptor.
    const tStore = tenantStorage.getStore();
    const m = tStore?.entityManager ?? this.dataSource.manager;
    const staffRow = await m.query(
      `SELECT id FROM staff_members WHERE user_id = $1 AND kindergarten_id = $2 LIMIT 1`,
      [callerUserId, kindergartenId],
    );
    const staffMemberId = staffRow[0]?.id ?? null;
    await m.query(
      `INSERT INTO attendance_events
         (id, kindergarten_id, child_id, event_type, method,
          recorded_at, recorded_by, pickup_request_id)
       VALUES ($1, $2, $3, 'check_out', $4, $5, $6, $7)`,
      [
        eventId,
        kindergartenId,
        childId,
        opts.method?.value ?? 'otp_pickup',
        now,
        staffMemberId,
        opts.pickupRequestId ?? null,
      ],
    );
    return { event: { id: eventId } };
  }
}

// ── Spec ──────────────────────────────────────────────────────────────────────

describeIntegration(
  'PickupRequestService — concurrent validateOtp (advisory lock)',
  () => {
    jest.setTimeout(60_000);

    let dataSource: DataSource;
    let kgId: string;
    let childId: string;
    let staffUserId: string;
    let staffMemberId: string;
    let requestId: string;

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
          PickupRequestTypeOrmEntity,
          TrustedPersonTypeOrmEntity,
          StaffMemberEntity,
          KindergartenEntity,
          UserEntity,
        ],
        synchronize: false,
        logging: false,
        poolSize: 10,
      });
      await dataSource.initialize();
    });

    afterAll(async () => {
      if (!dataSource?.isInitialized) return;
      await dataSource.destroy();
    });

    beforeEach(async () => {
      kgId = randomUUID();
      childId = randomUUID();
      staffUserId = randomUUID();
      staffMemberId = randomUUID();
      requestId = randomUUID();

      const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
      const staffPhone = `+7700${kgId.slice(0, 7).replace(/[^0-9]/g, '0')}`;
      const kgSlug = `race-kg-${kgId.slice(0, 8)}`;

      // Seed required FK rows. Wrap in a TX with `app.bypass_rls = 'true'`
      // because we connect as the non-superuser `shyraq_app` role and the
      // tenant tables FORCE RLS.
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(
          `INSERT INTO kindergartens (id, name, slug, is_active)
           VALUES ($1, 'Race KG', $2, true)`,
          [kgId, kgSlug],
        );
        await m.query(
          `INSERT INTO users (id, phone, full_name) VALUES ($1, $2, 'Staff Race')`,
          [staffUserId, staffPhone],
        );
        await m.query(
          `INSERT INTO children (id, kindergarten_id, full_name, date_of_birth, status)
           VALUES ($1, $2, 'Race Child', '2020-01-01', 'active')`,
          [childId, kgId],
        );
        await m.query(
          `INSERT INTO staff_members (id, kindergarten_id, user_id, role, is_active)
           VALUES ($1, $2, $3, 'mentor', true)`,
          [staffMemberId, kgId, staffUserId],
        );
        await m.query(
          `INSERT INTO pickup_requests
             (id, kindergarten_id, child_id, requested_by_user_id,
              trusted_person_phone, trusted_person_name, status, expires_at)
           VALUES ($1, $2, $3, $4, '+77011000001', 'Race Person', 'otp_sent', $5)`,
          [requestId, kgId, childId, staffUserId, expiresAt],
        );
      });
    });

    afterEach(async () => {
      if (!dataSource?.isInitialized) return;
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        // Break the FK cycle: pickup_requests.attendance_event_id ↔
        // attendance_events.pickup_request_id. NULL the back-reference on
        // pickup_requests first, then drop attendance_events, then
        // pickup_requests.
        await m.query(
          `UPDATE pickup_requests SET attendance_event_id = NULL WHERE kindergarten_id = $1`,
          [kgId],
        );
        await m.query(
          `DELETE FROM attendance_events WHERE kindergarten_id = $1`,
          [kgId],
        );
        await m.query(
          `DELETE FROM pickup_requests WHERE kindergarten_id = $1`,
          [kgId],
        );
        await m.query(`DELETE FROM staff_members WHERE kindergarten_id = $1`, [
          kgId,
        ]);
        await m.query(`DELETE FROM children WHERE kindergarten_id = $1`, [
          kgId,
        ]);
        await m.query(`DELETE FROM users WHERE id = $1`, [staffUserId]);
        await m.query(`DELETE FROM kindergartens WHERE id = $1`, [kgId]);
      });
    });

    function makeCtx(req: Record<string, unknown>): ExecutionContext {
      return {
        getType: () => 'http',
        switchToHttp: () => ({ getRequest: () => req }),
      } as unknown as ExecutionContext;
    }

    /**
     * Replicates the HTTP-pipeline TX wiring. Each runScoped call opens
     * its own DB transaction. The advisory lock acquired inside lives in
     * that TX and serializes concurrent callers.
     */
    async function runScoped<T>(
      kgIdArg: string,
      fn: () => Promise<T>,
    ): Promise<T> {
      const interceptor = new TenantContextInterceptor(dataSource);
      const next = { handle: () => defer(async () => fn()) };
      return (await lastValueFrom(
        interceptor.intercept(
          makeCtx({ tenant: { kgId: kgIdArg, bypass: false } }),
          next,
        ),
      )) as T;
    }

    function makeService(otpStore: FakePickupOtpStore): PickupRequestService {
      const prRepo = new PickupRequestRelationalRepository(
        dataSource.getRepository(PickupRequestTypeOrmEntity),
      );
      const tpRepo = new TrustedPersonRelationalRepository(
        dataSource.getRepository(TrustedPersonTypeOrmEntity),
      );
      const staffRepo = new StaffMemberRelationalRepository(
        dataSource.getRepository(StaffMemberEntity),
      );
      const authOtpStore = new FakeAuthOtpStore();
      const sms = new FakeSms();
      const notifications = new FakeNotifications();
      const clock = new FixedClock(new Date());
      const attendance = new FakeAttendanceService(dataSource);

      const configService = {
        getOrThrow: (key: string) => {
          if (key === 'auth.rateLimitOtpRequestLimit') return 5;
          if (key === 'auth.rateLimitOtpRequestWindowSec') return 3600;
          throw new Error(`Unexpected config key in race spec: ${key}`);
        },
      } as unknown as ConfigService;

      return new PickupRequestService(
        prRepo,
        tpRepo,
        null as unknown as ChildGuardianRepository,
        null as unknown as ChildRepository,
        null as unknown as KindergartenRepository,
        staffRepo,
        otpStore,
        authOtpStore,
        sms,
        notifications,
        attendance as unknown as AttendanceService,
        clock,
        configService,
      );
    }

    it('serializes concurrent validateOtp — exactly one caller validates, others get OtpExpiredError, single attendance row', async () => {
      const OTP_CODE = '123456';
      const otpStore = new FakePickupOtpStore();
      otpStore.seed(requestId, OTP_CODE);
      const service = makeService(otpStore);

      // Three concurrent validate calls. Each acquires the advisory lock
      // in sequence. The first calls attendance.checkOut + writes the
      // attendance row + flips status to validated + clearCode's the OTP
      // store. The second and third see the validated status and throw
      // PickupRequestAlreadyValidatedError — OR they see the OTP cleared
      // and throw OtpExpiredError. Either is acceptable — the
      // load-bearing invariants are "exactly one validated" + "exactly
      // one attendance_events row".
      const results = await Promise.allSettled([
        runScoped(kgId, () =>
          service.validateOtp(kgId, requestId, OTP_CODE, staffUserId),
        ),
        runScoped(kgId, () =>
          service.validateOtp(kgId, requestId, OTP_CODE, staffUserId),
        ),
        runScoped(kgId, () =>
          service.validateOtp(kgId, requestId, OTP_CODE, staffUserId),
        ),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(2);

      // The two losers reject with either OtpExpiredError (code cleared
      // by the winner) OR PickupRequestAlreadyValidatedError (the row's
      // terminal-state guard fires once the winner has flipped the status
      // to validated). Both are acceptable: the load-bearing invariant is
      // that they did NOT successfully validate. Post T7 fix M3 (clearCode
      // after DB writes) the typical outcome shifts toward
      // AlreadyValidatedError because the status flip happens before the
      // OTP cleanup.
      for (const r of rejected) {
        const ok =
          r.status === 'rejected' &&
          (r.reason instanceof OtpExpiredError ||
            r.reason instanceof PickupRequestAlreadyValidatedError);
        if (!ok) {
          throw new Error(
            `unexpected rejection: ${(r as PromiseRejectedResult).reason}`,
          );
        }
      }

      // DB invariant 1: pickup_requests.status = 'validated'.
      // DB invariant 2: exactly one attendance_events row for that
      // pickup_request_id.
      // Both reads bypass RLS since the test runs as `shyraq_app`.
      const { prRows, evtRows } = await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        const prRowsInner = (await m.query(
          `SELECT status, validated_by, attendance_event_id
           FROM pickup_requests WHERE id = $1`,
          [requestId],
        )) as Array<{
          status: string;
          validated_by: string | null;
          attendance_event_id: string | null;
        }>;
        const evtRowsInner = (await m.query(
          `SELECT id FROM attendance_events WHERE pickup_request_id = $1`,
          [requestId],
        )) as Array<{ id: string }>;
        return { prRows: prRowsInner, evtRows: evtRowsInner };
      });

      expect(prRows).toHaveLength(1);
      expect(prRows[0].status).toBe('validated');
      expect(prRows[0].validated_by).toBe(staffMemberId);
      expect(prRows[0].attendance_event_id).not.toBeNull();
      expect(evtRows).toHaveLength(1);
      expect(evtRows[0].id).toBe(prRows[0].attendance_event_id);
    });
  },
);
