/**
 * B11 Pickup OTP — concurrent validateOtp race-integration spec.
 *
 * Self-skips when `INTEGRATION_DB !== '1'` so `npm test` stays green
 * on machines without a configured tenant DB. Run with:
 *
 *   INTEGRATION_DB=1 DATABASE_USERNAME=shyraq_app DATABASE_PASSWORD=shyraq_app \
 *   npm test -- --testPathPattern pickup.race.integration
 *
 * What this guards: two concurrent `validateOtp` calls for the same
 * pickup_request (e.g. two staff members on different devices, a
 * network retry) must not both succeed — i.e. must not produce two
 * checkout attendance_events. The `pg_advisory_xact_lock` keyed on
 * `requestId` serializes access so the second concurrent call waits
 * behind the first and then observes that the OTP code has been cleared
 * (first caller consumed it via `clearCode`). The second call therefore
 * receives 422 `otp_expired_or_missing` rather than double-validating.
 *
 * The spec runs three concurrent `service.validateOtp(...)` calls
 * inside the same TenantContextInterceptor wiring the HTTP path uses,
 * and asserts:
 *   - Advisory lock serializes so at most 1 caller finds the OTP code.
 *   - At least 2 callers throw OtpExpiredError (code cleared by winner).
 *   - DB pickup_requests.status stays otp_sent because AttendanceService
 *     is null and all TXs roll back at the checkOut call.
 *
 * Note: Because AttendanceService is stubbed as null, the validateOtp TX
 * always rolls back after the advisory lock releases. This means the DB
 * pickup_request row stays in `otp_sent`. The important invariant is that
 * (a) the lock serializes the callers and (b) the second+third callers see
 * the code cleared by the first caller's in-memory fake OTP store.
 */
import 'reflect-metadata';
import { ExecutionContext } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { defer, lastValueFrom } from 'rxjs';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { TenantContextInterceptor } from '@/common/interceptors/tenant-context.interceptor';
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
import { ChildGuardianRepository } from '@/modules/child/infrastructure/persistence/child-guardian.repository';
import { ChildRepository } from '@/modules/child/infrastructure/persistence/child.repository';
import { KindergartenRepository } from '@/modules/kindergarten/infrastructure/persistence/kindergarten.repository';
import { StaffMemberRepository } from '@/modules/staff/infrastructure/persistence/staff-member.repository';
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

// ── Spec ──────────────────────────────────────────────────────────────────────

describeIntegration(
  'PickupRequestService — concurrent validateOtp (advisory lock)',
  () => {
    jest.setTimeout(60_000);

    let dataSource: DataSource;
    let kgId: string;
    let childId: string;
    let staffUserId: string;
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
        entities: [PickupRequestTypeOrmEntity, TrustedPersonTypeOrmEntity],
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
      requestId = randomUUID();

      const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
      const staffPhone = `+7700${kgId.slice(0, 7).replace(/[^0-9]/g, '0')}`;
      const kgSlug = `race-kg-${kgId.slice(0, 8)}`;

      // Seed required FK rows
      await dataSource.query(
        `INSERT INTO kindergartens (id, name, slug, is_active)
         VALUES ($1, 'Race KG', $2, true)`,
        [kgId, kgSlug],
      );
      await dataSource.query(
        `INSERT INTO users (id, phone, full_name) VALUES ($1, $2, 'Staff Race')`,
        [staffUserId, staffPhone],
      );
      await dataSource.query(
        `INSERT INTO children (id, kindergarten_id, full_name, date_of_birth, status)
         VALUES ($1, $2, 'Race Child', '2020-01-01', 'active')`,
        [childId, kgId],
      );
      await dataSource.query(
        `INSERT INTO staff_members (id, kindergarten_id, user_id, role, is_active)
         VALUES ($1, $2, $3, 'mentor', true)`,
        [randomUUID(), kgId, staffUserId],
      );
      await dataSource.query(
        `INSERT INTO pickup_requests
           (id, kindergarten_id, child_id, requested_by_user_id,
            trusted_person_phone, trusted_person_name, status, expires_at)
         VALUES ($1, $2, $3, $4, '+77011000001', 'Race Person', 'otp_sent', $5)`,
        [requestId, kgId, childId, staffUserId, expiresAt],
      );
    });

    afterEach(async () => {
      if (!dataSource?.isInitialized) return;
      await dataSource.query(
        `DELETE FROM pickup_requests WHERE kindergarten_id = $1`,
        [kgId],
      );
      await dataSource.query(
        `DELETE FROM staff_members WHERE kindergarten_id = $1`,
        [kgId],
      );
      await dataSource.query(
        `DELETE FROM children WHERE kindergarten_id = $1`,
        [kgId],
      );
      await dataSource.query(`DELETE FROM users WHERE id = $1`, [staffUserId]);
      await dataSource.query(`DELETE FROM kindergartens WHERE id = $1`, [kgId]);
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
      const authOtpStore = new FakeAuthOtpStore();
      const sms = new FakeSms();
      const notifications = new FakeNotifications();
      const clock = new FixedClock(new Date());

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
        null as unknown as StaffMemberRepository,
        otpStore,
        authOtpStore,
        sms,
        notifications,
        // AttendanceService is null — validateOtp TX rolls back at checkOut.
        // Intentional: testing lock serialization, not full checkout flow.
        null as unknown as AttendanceService,
        clock,
        dataSource,
        configService,
      );
    }

    it('serializes concurrent validateOtp — first caller clears OTP; subsequent callers get OtpExpiredError', async () => {
      const OTP_CODE = '123456';
      const otpStore = new FakePickupOtpStore();
      otpStore.seed(requestId, OTP_CODE);
      const service = makeService(otpStore);

      // Three concurrent validate calls. Each acquires the advisory lock in
      // sequence. The first clears the OTP code. The second and third find
      // no code and throw OtpExpiredError.
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

      // Because AttendanceService is null, the first winner's TX also rolls
      // back (TypeError at attendance.checkOut). All three callers reject —
      // but the important invariant is at most ONE caller found the code;
      // the other 2+ get OtpExpiredError.
      const expiredCount = results.filter(
        (r) => r.status === 'rejected' && r.reason instanceof OtpExpiredError,
      ).length;

      // Advisory lock guarantees clearCode was called exactly once —
      // so at least 2 callers found the code already cleared.
      expect(expiredCount).toBeGreaterThanOrEqual(2);

      // DB pickup_request stays otp_sent (all TXs rolled back due to null
      // AttendanceService).
      const rows = (await dataSource.query(
        `SELECT status FROM pickup_requests WHERE id = $1`,
        [requestId],
      )) as Array<{ status: string }>;

      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('otp_sent');
    });
  },
);
