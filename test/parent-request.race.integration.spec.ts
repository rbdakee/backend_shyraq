/**
 * B12 Parent Requests — concurrent accept race-integration spec.
 *
 * Self-skips when INTEGRATION_DB !== '1'. Run with:
 *
 *   $env:INTEGRATION_DB='1'; $env:DATABASE_USERNAME='shyraq_app'; $env:DATABASE_PASSWORD='shyraq_app'
 *   npm test -- test/parent-request.race.integration.spec.ts
 *
 * What this guards: two concurrent `acceptRequest` calls on the same pending
 * parent_request must not both succeed. The conditional UPDATE
 *   `UPDATE parent_requests SET status='accepted' WHERE id=? AND status='pending' RETURNING *`
 * is atomic — exactly one caller wins (gets a non-null updated row); the
 * other sees 0 rows returned and maps to `ParentRequestAlreadyProcessedError`.
 *
 * No advisory locks are used here (unlike the pickup advisory-lock pattern) —
 * the conditional UPDATE WHERE clause is the sole race-prevention mechanism.
 * This is correct for status-machine transitions that consist of a single
 * atomic row update (no concurrent side-effect writes that need serialisation).
 *
 * Post-conditions:
 *   - Exactly 1 call returns an updated ParentRequest (status='accepted').
 *   - Exactly 1 call throws ParentRequestAlreadyProcessedError.
 *   - DB row: status='accepted', reviewed_by populated, exactly 1 row.
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
  ParentRequestAcceptedEvent,
  ParentRequestCancelledEvent,
  ParentRequestMessageSentEvent,
  ParentRequestRejectedEvent,
  PermissionsUpdatedEvent,
  PickupOtpSentEvent,
  PickupValidatedEvent,
  TimelineEntryCreatedEvent,
} from '@/common/notifications/notification.port';
import { ParentRequestAlreadyProcessedError } from '@/modules/parent-request/domain/errors/parent-request-already-processed.error';
import { StaffMemberRelationalRepository } from '@/modules/staff/infrastructure/persistence/relational/repositories/staff-member.repository';
import { StaffMemberEntity } from '@/modules/staff/infrastructure/persistence/relational/entities/staff-member.entity';
import { KindergartenEntity } from '@/modules/kindergarten/infrastructure/persistence/relational/entities/kindergarten.entity';
import { UserEntity } from '@/modules/users/infrastructure/persistence/relational/entities/user.entity';
import { InvoiceService } from '@/modules/billing/invoice.service';
import { ChildGuardianRepository } from '@/modules/child/infrastructure/persistence/child-guardian.repository';
import { ChildRepository } from '@/modules/child/infrastructure/persistence/child.repository';
import { GroupRepository } from '@/modules/group/infrastructure/persistence/group.repository';
import { KindergartenRepository } from '@/modules/kindergarten/infrastructure/persistence/kindergarten.repository';
import { UserRepository } from '@/modules/users/infrastructure/persistence/user.repository';
import { TrustedPersonRepository } from '@/modules/pickup/infrastructure/persistence/trusted-person.repository';
import { PickupRequestRepository } from '@/modules/pickup/infrastructure/persistence/pickup-request.repository';
import {
  ParentRequestService,
  CallerStaffContext,
} from '@/modules/parent-request/parent-request.service';
import { ParentRequestRelationalRepository } from '@/modules/parent-request/infrastructure/persistence/relational/repositories/parent-request.relational-repository';
import { ParentRequestMessageRelationalRepository } from '@/modules/parent-request/infrastructure/persistence/relational/repositories/parent-request-message.relational-repository';
import {
  ParentRequestOtpStorePort,
  StoredParentRequestOtp,
} from '@/modules/parent-request/infrastructure/otp/parent-request-otp-store.port';
import { ParentRequestTypeOrmEntity } from '@/modules/parent-request/infrastructure/persistence/relational/entities/parent-request.typeorm.entity';
import { ParentRequestMessageTypeOrmEntity } from '@/modules/parent-request/infrastructure/persistence/relational/entities/parent-request-message.typeorm.entity';

const SHOULD_RUN = process.env.INTEGRATION_DB === '1';
const describeIntegration = SHOULD_RUN ? describe : describe.skip;

// ── Fake ports ────────────────────────────────────────────────────────────────

class FakeParentRequestOtpStore extends ParentRequestOtpStorePort {
  storeCode(_userId: string, _code: string, _ttl: number): Promise<string> {
    return Promise.resolve('otp:ref');
  }
  readCode(_userId: string): Promise<StoredParentRequestOtp | null> {
    return Promise.resolve(null);
  }
  clearCode(_userId: string): Promise<void> {
    return Promise.resolve();
  }
  incrementAttempts(_userId: string): Promise<number> {
    return Promise.resolve(1);
  }
  lockUser(_userId: string, _ttl: number): Promise<void> {
    return Promise.resolve();
  }
  isLocked(_userId: string): Promise<boolean> {
    return Promise.resolve(false);
  }
}

class FakeAuthOtpStore extends OtpStorePort {
  checkRateLimit(
    _phone: string,
    _limit: number,
    _window: number,
  ): Promise<'ok' | 'exceeded'> {
    return Promise.resolve('ok');
  }
  checkRateLimitGeneric(
    _key: string,
    _limit: number,
    _window: number,
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
    return Promise.resolve({ txnId: 'fake' });
  }
  sendOtp(_phone: string, _code: string): Promise<SmsSendResult> {
    return Promise.resolve({ txnId: 'fake-otp' });
  }
  sendAdminInvite(_phone: string, _kg: string): Promise<SmsSendResult> {
    return Promise.resolve({ txnId: 'fake-admin-invite' });
  }
  sendStaffInvite(_phone: string, _kg: string): Promise<SmsSendResult> {
    return Promise.resolve({ txnId: 'fake-staff-invite' });
  }
  sendTrustedPersonAssigned(
    _phone: string,
    _child: string,
    _kg: string,
  ): Promise<SmsSendResult> {
    return Promise.resolve({ txnId: 'fake-trusted-person' });
  }
  sendPickupOtp(
    _phone: string,
    _child: string,
    _kg: string,
    _code: string,
  ): Promise<SmsSendResult> {
    return Promise.resolve({ txnId: 'fake-pickup-otp' });
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
  notifyParentRequestAccepted(_e: ParentRequestAcceptedEvent): Promise<void> {
    return Promise.resolve();
  }
  notifyParentRequestRejected(_e: ParentRequestRejectedEvent): Promise<void> {
    return Promise.resolve();
  }
  notifyParentRequestCancelled(_e: ParentRequestCancelledEvent): Promise<void> {
    return Promise.resolve();
  }
  notifyParentRequestMessageSent(
    _e: ParentRequestMessageSentEvent,
  ): Promise<void> {
    return Promise.resolve();
  }
  notifyInvoiceCreated(): Promise<void> {
    return Promise.resolve();
  }
  notifyInvoicePaid(): Promise<void> {
    return Promise.resolve();
  }
  notifyInvoiceOverdue(): Promise<void> {
    return Promise.resolve();
  }
  notifyInvoiceCancelled(): Promise<void> {
    return Promise.resolve();
  }
  notifyPaymentCompleted(): Promise<void> {
    return Promise.resolve();
  }
  notifyPaymentFailed(): Promise<void> {
    return Promise.resolve();
  }
  notifyPaymentRefunded(): Promise<void> {
    return Promise.resolve();
  }
  notifyRefundProcessed(): Promise<void> {
    return Promise.resolve();
  }
  notifyEnrollmentFirstInvoiceSkipped(): Promise<void> {
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
  'ParentRequestService — concurrent acceptRequest (conditional UPDATE WHERE status=pending)',
  () => {
    jest.setTimeout(60_000);

    let dataSource: DataSource;
    let kgId: string;
    let childId: string;
    let adminUserId: string;
    let adminStaffMemberId: string;
    let parentRequestId: string;

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
          ParentRequestTypeOrmEntity,
          ParentRequestMessageTypeOrmEntity,
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
      adminUserId = randomUUID();
      adminStaffMemberId = randomUUID();
      parentRequestId = randomUUID();

      const parentUserId = randomUUID();
      const kgSlug = `race-pr-${kgId.slice(0, 8)}`;
      const adminPhone = `+7700${kgId.slice(0, 7).replace(/[^0-9]/g, '0')}`;

      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(
          `INSERT INTO kindergartens (id, name, slug, is_active) VALUES ($1, 'Race PR KG', $2, true)`,
          [kgId, kgSlug],
        );
        await m.query(
          `INSERT INTO users (id, phone, full_name) VALUES ($1, $2, 'Admin Race')`,
          [adminUserId, adminPhone],
        );
        await m.query(
          `INSERT INTO users (id, phone, full_name) VALUES ($1, '+77000000001', 'Parent Race')`,
          [parentUserId],
        );
        await m.query(
          `INSERT INTO children (id, kindergarten_id, full_name, date_of_birth, status)
           VALUES ($1, $2, 'Race Child', '2020-01-01', 'active')`,
          [childId, kgId],
        );
        await m.query(
          `INSERT INTO staff_members (id, kindergarten_id, user_id, role, is_active)
           VALUES ($1, $2, $3, 'admin', true)`,
          [adminStaffMemberId, kgId, adminUserId],
        );
        await m.query(
          `INSERT INTO child_guardians
             (id, kindergarten_id, child_id, user_id, role, status, can_pickup, has_approval_rights, permissions, approved_by, approved_at)
           VALUES ($1, $2, $3, $4, 'primary', 'approved', true, true, '{}', $4, now())`,
          [randomUUID(), kgId, childId, parentUserId],
        );
        // Insert a pending parent_request
        await m.query(
          `INSERT INTO parent_requests
             (id, kindergarten_id, child_id, requester_user_id, request_type, status, details, recipient_type)
           VALUES ($1, $2, $3, $4, 'day_off', 'pending', '{"weekend_dates":["2099-01-06"]}', 'admin')`,
          [parentRequestId, kgId, childId, parentUserId],
        );
      });
    });

    afterEach(async () => {
      if (!dataSource?.isInitialized) return;
      await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        await m.query(
          `DELETE FROM parent_request_messages WHERE kindergarten_id = $1`,
          [kgId],
        );
        await m.query(
          `DELETE FROM parent_requests WHERE kindergarten_id = $1`,
          [kgId],
        );
        await m.query(
          `DELETE FROM child_guardians WHERE kindergarten_id = $1`,
          [kgId],
        );
        await m.query(`DELETE FROM staff_members WHERE kindergarten_id = $1`, [
          kgId,
        ]);
        await m.query(`DELETE FROM children WHERE kindergarten_id = $1`, [
          kgId,
        ]);
        await m.query(`DELETE FROM users WHERE id = $1`, [adminUserId]);
        await m.query(`DELETE FROM kindergartens WHERE id = $1`, [kgId]);
      });
    });

    function makeCtx(req: Record<string, unknown>): ExecutionContext {
      return {
        getType: () => 'http',
        switchToHttp: () => ({ getRequest: () => req }),
      } as unknown as ExecutionContext;
    }

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

    function makeService(): ParentRequestService {
      const prRepo = new ParentRequestRelationalRepository(
        dataSource.getRepository(ParentRequestTypeOrmEntity),
        dataSource,
      );
      const msgRepo = new ParentRequestMessageRelationalRepository(
        dataSource.getRepository(ParentRequestMessageTypeOrmEntity),
      );
      const staffRepo = new StaffMemberRelationalRepository(
        dataSource.getRepository(StaffMemberEntity),
      );
      const otpStore = new FakeParentRequestOtpStore();
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

      return new ParentRequestService(
        prRepo,
        msgRepo,
        null as unknown as ChildGuardianRepository,
        null as unknown as ChildRepository,
        staffRepo,
        null as unknown as GroupRepository,
        null as unknown as TrustedPersonRepository,
        null as unknown as PickupRequestRepository,
        otpStore,
        authOtpStore,
        sms,
        notifications,
        clock,
        configService,
        // Race spec exercises only `acceptRequest(day_off)` — the
        // late_pickup branch is the only path that calls invoiceService,
        // so a null cast is safe here. Hitting it would surface a clear
        // TypeError rather than a silent no-op.
        null as unknown as InvoiceService,
        // users + kindergartenRepo are only touched by the trusted-person
        // OTP-send / assign-notice paths, which this race spec never hits.
        null as unknown as UserRepository,
        null as unknown as KindergartenRepository,
      );
    }

    it('serializes concurrent acceptRequest — exactly one caller accepts, the other throws ParentRequestAlreadyProcessedError, single DB row accepted', async () => {
      const service = makeService();

      const callerA: CallerStaffContext = {
        staffMemberId: adminStaffMemberId,
        userId: adminUserId,
        role: 'admin',
      };
      // Simulate a second admin session (same staff_member_id — it is the same person
      // in two browser tabs). The conditional UPDATE decides the winner, not the caller.
      const callerB: CallerStaffContext = {
        staffMemberId: adminStaffMemberId,
        userId: adminUserId,
        role: 'admin',
      };

      const results = await Promise.allSettled([
        runScoped(kgId, () =>
          service.acceptRequest(kgId, callerA, parentRequestId, null),
        ),
        runScoped(kgId, () =>
          service.acceptRequest(kgId, callerB, parentRequestId, null),
        ),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      // The loser must throw ParentRequestAlreadyProcessedError (409).
      const loser = rejected[0] as PromiseRejectedResult;
      expect(loser.reason).toBeInstanceOf(ParentRequestAlreadyProcessedError);

      // DB invariants: exactly one row, status='accepted', reviewed_by populated.
      const rows = (await dataSource.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        return m.query(
          `SELECT status, reviewed_by FROM parent_requests WHERE id = $1`,
          [parentRequestId],
        );
      })) as Array<{ status: string; reviewed_by: string | null }>;

      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('accepted');
      expect(rows[0].reviewed_by).toBe(adminStaffMemberId);
    });
  },
);
