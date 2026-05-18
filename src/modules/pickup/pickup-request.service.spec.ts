/**
 * PickupRequestService — service-unit suite. Hand-written in-memory fakes
 * for every collaborator (no Jest auto-mock).
 *
 * Coverage matrix:
 *   - createByStaff: whitelist branch (snapshots from trusted_people row)
 *   - createByStaff: ad-hoc branch (snapshots from body fields)
 *   - createByStaff: trusted_person revoked → TrustedPersonRevokedError
 *   - createByStaff: trusted_person not for child → TrustedPersonNotForChildError
 *   - createByParent: missing pickup-permission → ForbiddenActionError
 *   - sendOtp: rate-limit exceeded → OtpRateLimitedError
 *   - sendOtp: locked → OtpLockedError
 *   - sendOtp: stores code, sends SMS, fires notification
 *   - validateOtp: happy path → check-out called with method=otp_pickup +
 *     pickupRequestId, pickup-guardian validation NOT triggered
 *   - validateOtp: wrong code → OtpInvalidError + recordFailedAttempt
 *   - validateOtp: 3rd wrong → OtpLockedError + lockRequest
 *   - validateOtp: expired Redis → PickupOtpExpiredError (T7-5 MEDIUM#5)
 *   - validateOtp: already validated → AlreadyValidated
 *   - cancel: happy + DEL Redis key
 *
 * Test names: `it('returns ...')`, `it('throws ...')` — never `should`.
 */
import { ConfigService } from '@nestjs/config';
import {
  AttendanceCheckInEvent,
  AttendanceCheckOutEvent,
  ChildTransferredEvent,
  DailyStatusChangedEvent,
  GuardianApprovedEvent,
  GuardianPendingApprovalEvent,
  GuardianRejectedEvent,
  GuardianRevokedEvent,
  NotificationPort,
  PermissionsUpdatedEvent,
  PickupOtpSentEvent,
  PickupValidatedEvent,
  TimelineEntryCreatedEvent,
} from '@/common/notifications/notification.port';
import { OtpInvalidError } from '@/modules/auth/domain/errors/otp-invalid.error';
import { OtpLockedError } from '@/modules/auth/domain/errors/otp-locked.error';
import { OtpRateLimitedError } from '@/modules/auth/domain/errors/otp-rate-limited.error';
import { OtpStorePort, StoredOtp } from '@/modules/auth/otp-store.port';
import { SmsPort } from '@/modules/auth/sms.port';
import { Child } from '@/modules/child/domain/entities/child.entity';
import { ChildGuardian } from '@/modules/child/domain/entities/child-guardian.entity';
import { PickupOtpExpiredError } from './domain/errors/pickup-otp-expired.error';
import { PickupRequestExpiredError } from './domain/errors/pickup-request-expired.error';
import { ChildNotFoundError } from '@/modules/child/domain/errors/child-not-found.error';
import { ChildGuardianRepository } from '@/modules/child/infrastructure/persistence/child-guardian.repository';
import {
  ChildGroupHistoryRecord,
  ChildListFilters,
  ChildRepository,
  PageRequest,
  PageResult,
} from '@/modules/child/infrastructure/persistence/child.repository';
import { Kindergarten } from '@/modules/kindergarten/domain/entities/kindergarten.entity';
import {
  KindergartenFilters,
  KindergartenListResult,
  KindergartenRepository,
  KindergartenUpdateInput,
} from '@/modules/kindergarten/infrastructure/persistence/kindergarten.repository';
import { StaffMember } from '@/modules/staff/domain/entities/staff-member.entity';
import { StaffNotFoundError } from '@/modules/staff/domain/errors/staff-not-found.error';
import {
  CreateStaffMemberInput,
  ListStaffFilters,
  StaffMemberRepository,
  UpdateStaffMemberInput,
} from '@/modules/staff/infrastructure/persistence/staff-member.repository';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { ForbiddenActionError } from '@/shared-kernel/domain/errors';
import { AttendanceService } from '@/modules/attendance/attendance.service';
import { PickupRequest } from './domain/entities/pickup-request.entity';
import { PickupRequestAlreadyValidatedError } from './domain/errors/pickup-request-already-validated.error';
import { PickupRequestNotFoundError } from './domain/errors/pickup-request-not-found.error';
import { PickupRequestStatusInvalidError } from './domain/errors/pickup-request-status-invalid.error';
import { TrustedPersonNotForChildError } from './domain/errors/trusted-person-not-for-child.error';
import { TrustedPersonRevokedError } from './domain/errors/trusted-person-revoked.error';
import { TrustedPerson } from './domain/entities/trusted-person.entity';
import {
  PickupOtpStorePort,
  StoredPickupOtp,
} from './infrastructure/otp/pickup-otp-store.port';
import {
  CreatePickupRequestRow,
  ListPickupFilters,
  PickupRequestPatch,
  PickupRequestRepository,
  PickupRequestUpdateOpts,
} from './infrastructure/persistence/pickup-request.repository';
import {
  CreateTrustedPersonRow,
  TrustedPersonPatch,
  TrustedPersonRepository,
} from './infrastructure/persistence/trusted-person.repository';
import { PickupRequestService } from './pickup-request.service';

// ── Constants ────────────────────────────────────────────────────────────

const KG = '11111111-1111-1111-1111-111111111111';
const CHILD = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const PARENT_USER = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa';
const STAFF_USER = 'aaaaaaaa-2222-2222-2222-aaaaaaaaaaaa';
const STAFF_ID = 'bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb';
const TP_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const NOW = new Date('2026-05-01T09:00:00.000Z');
const TRUSTED_PHONE = '+77071234567';

class FixedClock extends ClockPort {
  constructor(private fixed: Date) {
    super();
  }
  now(): Date {
    return this.fixed;
  }
  set(d: Date): void {
    this.fixed = d;
  }
}

// ── Fakes ────────────────────────────────────────────────────────────────

class FakePickupRequestRepo extends PickupRequestRepository {
  rows = new Map<string, PickupRequest>();
  advisoryLockCalls: string[] = [];
  private nextId = 0;

  create(input: CreatePickupRequestRow): Promise<PickupRequest> {
    const id = `pr-${++this.nextId}`;
    const pr = PickupRequest.create({
      id,
      kindergartenId: input.kindergartenId,
      childId: input.childId,
      requestedByUserId: input.requestedByUserId,
      trustedPersonId: input.trustedPersonId,
      trustedPersonPhone: input.trustedPersonPhone,
      trustedPersonName: input.trustedPersonName,
      trustedPersonIin: input.trustedPersonIin,
      expiresAt: input.expiresAt,
      parentRequestId: input.parentRequestId ?? null,
      createdAt: new Date(NOW.getTime()),
    });
    this.rows.set(id, pr);
    return Promise.resolve(pr);
  }

  findById(id: string): Promise<PickupRequest | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }

  findByIdForUpdate(id: string): Promise<PickupRequest | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }

  listByKindergarten(filters: ListPickupFilters): Promise<PickupRequest[]> {
    return Promise.resolve(
      [...this.rows.values()].filter(
        (pr) =>
          pr.kindergartenId === filters.kindergartenId &&
          (!filters.status || pr.status === filters.status),
      ),
    );
  }

  update(
    id: string,
    patch: PickupRequestPatch,
    opts: PickupRequestUpdateOpts = {},
  ): Promise<boolean> {
    const pr = this.rows.get(id);
    if (!pr) return Promise.resolve(false);
    if (
      opts.expectedStatus !== undefined &&
      pr.status !== opts.expectedStatus
    ) {
      return Promise.resolve(false);
    }
    const s = pr.toState();
    const next = PickupRequest.fromState({
      ...s,
      status: patch.status ?? s.status,
      otpRef: patch.otpRef !== undefined ? patch.otpRef : s.otpRef,
      validatedBy:
        patch.validatedBy !== undefined ? patch.validatedBy : s.validatedBy,
      validatedAt:
        patch.validatedAt !== undefined ? patch.validatedAt : s.validatedAt,
      attendanceEventId:
        patch.attendanceEventId !== undefined
          ? patch.attendanceEventId
          : s.attendanceEventId,
    });
    this.rows.set(id, next);
    return Promise.resolve(true);
  }

  acquireValidateAdvisoryLock(requestId: string): Promise<void> {
    this.advisoryLockCalls.push(requestId);
    return Promise.resolve();
  }
}

class FakeTrustedPersonRepo extends TrustedPersonRepository {
  rows = new Map<string, TrustedPerson>();
  markUsedCalls: { id: string; deactivate: boolean }[] = [];
  /** B22b T7 M18: counts `findById` invocations so the service-spec can
   * assert that validateOtp issues at most one fetch per trusted_person
   * row (single-fetch collapse). */
  findByIdCalls: string[] = [];

  put(tp: TrustedPerson): void {
    this.rows.set(tp.id, tp);
  }

  create(input: CreateTrustedPersonRow): Promise<TrustedPerson> {
    const tp = TrustedPerson.create({
      id: `tp-${this.rows.size + 1}`,
      kindergartenId: input.kindergartenId,
      childId: input.childId,
      addedByUserId: input.addedByUserId,
      fullName: input.fullName,
      phone: input.phone,
      iin: input.iin,
      relation: input.relation,
      photoUrl: input.photoUrl,
      isOneTime: input.isOneTime,
      createdAt: NOW,
    });
    this.rows.set(tp.id, tp);
    return Promise.resolve(tp);
  }

  findById(id: string): Promise<TrustedPerson | null> {
    this.findByIdCalls.push(id);
    return Promise.resolve(this.rows.get(id) ?? null);
  }

  listByChild(_kg: string, _cid: string): Promise<TrustedPerson[]> {
    return Promise.resolve([...this.rows.values()]);
  }

  update(
    id: string,
    _patch: TrustedPersonPatch,
  ): Promise<TrustedPerson | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }

  markRevoked(id: string, now: Date): Promise<void> {
    const tp = this.rows.get(id);
    if (tp) this.rows.set(id, tp.revoke(now));
    return Promise.resolve();
  }

  /**
   * Tracks `claimed` boolean per call. Tests can set
   * `markUsedNextResult = false` to simulate the concurrent-claim loser
   * (T7-5 HIGH#2 race-loss path). Default: returns true and stamps
   * `usedAt`.
   */
  markUsedNextResult: boolean | null = null;
  markUsed(id: string, now: Date, deactivate: boolean): Promise<boolean> {
    this.markUsedCalls.push({ id, deactivate });
    const claimed = this.markUsedNextResult ?? true;
    if (claimed) {
      const tp = this.rows.get(id);
      if (tp) this.rows.set(id, tp.markUsed(now));
    }
    this.markUsedNextResult = null;
    return Promise.resolve(claimed);
  }
}

class FakeChildGuardianRepo extends ChildGuardianRepository {
  pickupGuardians: ChildGuardian[] = [];

  put(g: ChildGuardian): void {
    this.pickupGuardians.push(g);
  }

  create(_g: ChildGuardian): Promise<void> {
    return Promise.resolve();
  }
  findById(): Promise<ChildGuardian | null> {
    return Promise.resolve(null);
  }
  findByChildId(): Promise<ChildGuardian[]> {
    return Promise.resolve([]);
  }
  findActiveByChildAndUser(): Promise<ChildGuardian | null> {
    return Promise.resolve(null);
  }
  findApprovedByChildAndUserCrossTenant(): Promise<ChildGuardian | null> {
    return Promise.resolve(null);
  }
  findByIdCrossTenant(): Promise<ChildGuardian | null> {
    return Promise.resolve(null);
  }
  findPendingForPrimary(): Promise<ChildGuardian[]> {
    return Promise.resolve([]);
  }
  update(): Promise<void> {
    return Promise.resolve();
  }
  countApprovalRights(): Promise<number> {
    return Promise.resolve(0);
  }
  acquireApprovalRightsLock(): Promise<void> {
    return Promise.resolve();
  }
  listApprovedKindergartenIdsByUserId(): Promise<string[]> {
    return Promise.resolve([]);
  }
  findApprovedByUser(): Promise<ChildGuardian[]> {
    return Promise.resolve([]);
  }
  findPendingPrimaryByUserIdCrossTenant(): Promise<ChildGuardian[]> {
    return Promise.resolve([]);
  }
  findApprovedActivePickupGuardian(
    kg: string,
    childId: string,
    userId: string,
  ): Promise<ChildGuardian | null> {
    const r =
      this.pickupGuardians.find((g) => {
        const s = g.toState();
        return (
          s.kindergartenId === kg &&
          s.childId === childId &&
          s.userId === userId &&
          s.status === 'approved' &&
          s.revokedAt === null &&
          s.canPickup === true
        );
      }) ?? null;
    return Promise.resolve(r);
  }
  findApprovedActiveByUserIdCrossTenant(): Promise<ChildGuardian[]> {
    return Promise.resolve([]);
  }
  findApprovedActiveByUserAndChild(
    kg: string,
    childId: string,
    userId: string,
  ): Promise<ChildGuardian | null> {
    const r =
      this.pickupGuardians.find((g) => {
        const s = g.toState();
        return (
          s.kindergartenId === kg &&
          s.childId === childId &&
          s.userId === userId &&
          s.status === 'approved' &&
          s.revokedAt === null
        );
      }) ?? null;
    return Promise.resolve(r);
  }
}

class FakeChildRepo extends ChildRepository {
  byId = new Map<string, Child>();
  put(c: Child): void {
    this.byId.set(c.id, c);
  }
  create(): Promise<void> {
    return Promise.resolve();
  }
  findById(_kg: string, id: string): Promise<Child | null> {
    return Promise.resolve(this.byId.get(id) ?? null);
  }
  findByKindergartenAndIin(): Promise<Child | null> {
    return Promise.resolve(null);
  }
  update(): Promise<void> {
    return Promise.resolve();
  }
  list(
    _kg: string,
    _f: ChildListFilters,
    _p: PageRequest,
  ): Promise<PageResult<Child>> {
    return Promise.resolve({ items: [], total: 0 });
  }
  countActiveByGroup(): Promise<number> {
    return Promise.resolve(0);
  }
  recordGroupTransfer(): Promise<void> {
    return Promise.resolve();
  }
  listGroupHistory(): Promise<ChildGroupHistoryRecord[]> {
    return Promise.resolve([]);
  }
  findByIinCrossTenant(): Promise<Child[]> {
    return Promise.resolve([]);
  }
  findByIdsCrossTenant(): Promise<Child[]> {
    return Promise.resolve([]);
  }
}

class FakeKindergartenRepo extends KindergartenRepository {
  byId = new Map<string, Kindergarten>();
  put(k: Kindergarten): void {
    this.byId.set(k.id, k);
  }
  create(): Promise<Kindergarten> {
    throw new Error('not used');
  }
  findById(id: string): Promise<Kindergarten | null> {
    return Promise.resolve(this.byId.get(id) ?? null);
  }
  findBySlug(): Promise<Kindergarten | null> {
    return Promise.resolve(null);
  }
  findAll(_f: KindergartenFilters): Promise<KindergartenListResult> {
    return Promise.resolve({
      items: [...this.byId.values()],
      total: 0,
      limit: 0,
      offset: 0,
    });
  }
  listActive(): Promise<Kindergarten[]> {
    return Promise.resolve([...this.byId.values()]);
  }
  update(_id: string, _u: KindergartenUpdateInput): Promise<Kindergarten> {
    throw new Error('not used');
  }
}

class FakeStaffRepo extends StaffMemberRepository {
  byUserKg = new Map<string, StaffMember>();
  put(s: StaffMember): void {
    this.byUserKg.set(`${s.kindergartenId}|${s.userId}`, s);
  }
  create(_input: CreateStaffMemberInput): Promise<StaffMember> {
    throw new Error('not used');
  }
  findById(): Promise<StaffMember | null> {
    return Promise.resolve(null);
  }
  findActiveByUserAndKindergarten(
    userId: string,
    kg: string,
  ): Promise<StaffMember | null> {
    return Promise.resolve(this.byUserKg.get(`${kg}|${userId}`) ?? null);
  }
  findByUserAndKindergarten(
    userId: string,
    kg: string,
  ): Promise<StaffMember | null> {
    return Promise.resolve(this.byUserKg.get(`${kg}|${userId}`) ?? null);
  }
  listByKindergarten(
    _kg: string,
    _f?: ListStaffFilters,
  ): Promise<StaffMember[]> {
    return Promise.resolve([]);
  }
  update(
    _kg: string,
    _id: string,
    _patch: UpdateStaffMemberInput,
  ): Promise<StaffMember | null> {
    return Promise.resolve(null);
  }
  save(s: StaffMember): Promise<StaffMember> {
    return Promise.resolve(s);
  }
  deactivateAllByKindergarten(): Promise<number> {
    return Promise.resolve(0);
  }
  findAllActiveByUserId(): Promise<StaffMember[]> {
    return Promise.resolve([]);
  }
}

class FakePickupOtpStore extends PickupOtpStorePort {
  codes = new Map<string, StoredPickupOtp>();
  locks = new Set<string>();
  attempts = new Map<string, number>();
  storeCalls: { requestId: string; code: string; ttl: number }[] = [];
  lockCalls: string[] = [];

  storeCode(requestId: string, code: string, ttlSec: number): Promise<string> {
    this.codes.set(requestId, { code, attempts: 0 });
    this.attempts.set(requestId, 0);
    this.storeCalls.push({ requestId, code, ttl: ttlSec });
    return Promise.resolve(`otp:pickup:${requestId}`);
  }
  readCode(requestId: string): Promise<StoredPickupOtp | null> {
    return Promise.resolve(this.codes.get(requestId) ?? null);
  }
  clearCode(requestId: string): Promise<void> {
    this.codes.delete(requestId);
    return Promise.resolve();
  }
  incrementAttempts(requestId: string): Promise<number> {
    const next = (this.attempts.get(requestId) ?? 0) + 1;
    this.attempts.set(requestId, next);
    return Promise.resolve(next);
  }
  lockRequest(requestId: string, _ttl: number): Promise<void> {
    this.locks.add(requestId);
    this.lockCalls.push(requestId);
    return Promise.resolve();
  }
  isLocked(requestId: string): Promise<boolean> {
    return Promise.resolve(this.locks.has(requestId));
  }

  /** Simulate Redis TTL eviction. */
  evict(requestId: string): void {
    this.codes.delete(requestId);
  }
}

class FakeAuthOtpStore extends OtpStorePort {
  rateLimitState: 'ok' | 'exceeded' = 'ok';
  rateLimitCalls = 0;

  checkRateLimit(): Promise<'ok' | 'exceeded'> {
    this.rateLimitCalls += 1;
    return Promise.resolve(this.rateLimitState);
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
}

class FakeSmsPort extends SmsPort {
  sent: { phone: string; message: string }[] = [];
  send(phone: string, message: string): Promise<{ txnId: string }> {
    this.sent.push({ phone, message });
    return Promise.resolve({ txnId: `sms-${this.sent.length}` });
  }
}

class FakeNotificationPort extends NotificationPort {
  pickupOtpSent: PickupOtpSentEvent[] = [];
  pickupValidated: PickupValidatedEvent[] = [];

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
  notifyGuardianSelfRevoked(): Promise<void> {
    return Promise.resolve();
  }
  notifyPickupOtpSent(e: PickupOtpSentEvent): Promise<void> {
    this.pickupOtpSent.push(e);
    return Promise.resolve();
  }
  notifyPickupValidated(e: PickupValidatedEvent): Promise<void> {
    this.pickupValidated.push(e);
    return Promise.resolve();
  }
  notifyParentRequestAccepted(): Promise<void> {
    return Promise.resolve();
  }
  notifyParentRequestRejected(): Promise<void> {
    return Promise.resolve();
  }
  notifyParentRequestCancelled(): Promise<void> {
    return Promise.resolve();
  }
  notifyParentRequestMessageSent(): Promise<void> {
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

class FakeAttendanceService {
  checkOutCalls: {
    kg: string;
    childId: string;
    callerUserId: string;
    pickupUserId: string | null;
    method?: string;
    pickupRequestId?: string | null;
  }[] = [];

  // Mirror only the shape we need. Service uses `attendance.checkOut(...)`.
  // Returns `{ event: { id } }` because that's all the service touches.
  checkOut(
    kg: string,
    childId: string,
    callerUserId: string,
    pickupUserId: string | null,
    opts: {
      method?: { value: string };
      pickupRequestId?: string | null;
    } = {},
  ): Promise<{ event: { id: string } }> {
    this.checkOutCalls.push({
      kg,
      childId,
      callerUserId,
      pickupUserId,
      method: opts.method?.value,
      pickupRequestId: opts.pickupRequestId ?? null,
    });
    return Promise.resolve({ event: { id: 'evt-1' } });
  }
}

class FakeConfig {
  getOrThrow(key: string): unknown {
    if (key === 'auth.rateLimitOtpRequestLimit') return 5;
    if (key === 'auth.rateLimitOtpRequestWindowSec') return 3600;
    throw new Error(`unhandled config key: ${key}`);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function makeChild(): Child {
  return Child.hydrate({
    id: CHILD,
    kindergartenId: KG,
    iin: null,
    fullName: 'Test Child',
    dateOfBirth: new Date('2022-01-01'),
    gender: null,
    photoUrl: null,
    status: 'active',
    currentGroupId: null,
    enrollmentDate: NOW,
    archivedAt: null,
    archiveReason: null,
    medicalNotes: null,
    allergyNotes: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function makeKindergarten(): Kindergarten {
  return Kindergarten.hydrate({
    id: KG,
    name: 'Sunshine Kindergarten',
    slug: 'sunshine',
    address: null,
    phone: null,
    plan: 'basic',
    settings: {} as never,
    isActive: true,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function makeStaff(): StaffMember {
  return StaffMember.hydrate({
    id: STAFF_ID,
    kindergartenId: KG,
    userId: STAFF_USER,
    fullName: 'Mentor',
    phone: '+77770000000',
    role: 'mentor',
    specialistType: null,
    isActive: true,
    hiredAt: NOW,
    firedAt: null,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function makeApprovedPickupGuardian(
  overrides: Partial<{
    canPickup: boolean;
    revokedAt: Date | null;
    status: 'approved' | 'pending_approval' | 'rejected' | 'revoked';
  }> = {},
): ChildGuardian {
  return ChildGuardian.hydrate({
    id: 'g-1',
    kindergartenId: KG,
    childId: CHILD,
    userId: PARENT_USER,
    role: 'primary',
    status: overrides.status ?? 'approved',
    hasApprovalRights: true,
    approvedBy: PARENT_USER,
    approvedAt: NOW,
    revokedBy: null,
    revokedAt: overrides.revokedAt ?? null,
    canPickup: overrides.canPickup ?? true,
    permissions: {},
    permissionsUpdatedBy: null,
    permissionsUpdatedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function makeTrustedPerson(
  overrides: Partial<{
    childId: string;
    isActive: boolean;
    isOneTime: boolean;
    revokedAt: Date | null;
    usedAt: Date | null;
  }> = {},
): TrustedPerson {
  return TrustedPerson.fromState({
    id: TP_ID,
    kindergartenId: KG,
    childId: overrides.childId ?? CHILD,
    addedByUserId: PARENT_USER,
    fullName: 'Айгуль',
    phone: TRUSTED_PHONE,
    iin: null,
    relation: 'aunt',
    photoUrl: null,
    isActive: overrides.isActive ?? true,
    isOneTime: overrides.isOneTime ?? false,
    usedAt: overrides.usedAt ?? null,
    createdAt: NOW,
    revokedAt: overrides.revokedAt ?? null,
  });
}

interface Wired {
  service: PickupRequestService;
  pickupRequests: FakePickupRequestRepo;
  trustedPeople: FakeTrustedPersonRepo;
  childGuardians: FakeChildGuardianRepo;
  childRepo: FakeChildRepo;
  kindergartenRepo: FakeKindergartenRepo;
  staffRepo: FakeStaffRepo;
  otpStore: FakePickupOtpStore;
  authOtpStore: FakeAuthOtpStore;
  sms: FakeSmsPort;
  notifications: FakeNotificationPort;
  attendance: FakeAttendanceService;
  clock: FixedClock;
}

function wire(): Wired {
  const pickupRequests = new FakePickupRequestRepo();
  const trustedPeople = new FakeTrustedPersonRepo();
  const childGuardians = new FakeChildGuardianRepo();
  const childRepo = new FakeChildRepo();
  const kindergartenRepo = new FakeKindergartenRepo();
  const staffRepo = new FakeStaffRepo();
  const otpStore = new FakePickupOtpStore();
  const authOtpStore = new FakeAuthOtpStore();
  const sms = new FakeSmsPort();
  const notifications = new FakeNotificationPort();
  const attendance = new FakeAttendanceService();
  const clock = new FixedClock(NOW);

  childRepo.put(makeChild());
  kindergartenRepo.put(makeKindergarten());
  staffRepo.put(makeStaff());

  const service = new PickupRequestService(
    pickupRequests,
    trustedPeople,
    childGuardians,
    childRepo,
    kindergartenRepo,
    staffRepo,
    otpStore,
    authOtpStore,
    sms,
    notifications,
    attendance as unknown as AttendanceService,
    clock,
    new FakeConfig() as unknown as ConfigService,
  );

  return {
    service,
    pickupRequests,
    trustedPeople,
    childGuardians,
    childRepo,
    kindergartenRepo,
    staffRepo,
    otpStore,
    authOtpStore,
    sms,
    notifications,
    attendance,
    clock,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('PickupRequestService — service-unit', () => {
  describe('createByStaff', () => {
    it('returns a request with snapshot fields copied from the trusted_people whitelist row', async () => {
      const w = wire();
      w.trustedPeople.put(makeTrustedPerson());
      const pr = await w.service.createByStaff(KG, STAFF_USER, {
        childId: CHILD,
        trustedPersonId: TP_ID,
        // Body fields ignored when whitelist row is present.
        trustedPersonName: 'IGNORED',
        trustedPersonPhone: '+77000000000',
      });
      expect(pr.trustedPersonId).toBe(TP_ID);
      expect(pr.trustedPersonName).toBe('Айгуль');
      expect(pr.trustedPersonPhone).toBe(TRUSTED_PHONE);
      expect(pr.trustedPersonIin).toBeNull();
      expect(pr.status).toBe('otp_sent');
      expect(pr.requestedByUserId).toBe(STAFF_USER);
    });

    it('returns an ad-hoc request with snapshot fields copied from the body', async () => {
      const w = wire();
      const pr = await w.service.createByStaff(KG, STAFF_USER, {
        childId: CHILD,
        trustedPersonId: null,
        trustedPersonName: 'Driver Bob',
        trustedPersonPhone: '+77001112233',
        trustedPersonIin: '880101400123',
      });
      expect(pr.trustedPersonId).toBeNull();
      expect(pr.trustedPersonName).toBe('Driver Bob');
      expect(pr.trustedPersonPhone).toBe('+77001112233');
      expect(pr.trustedPersonIin).toBe('880101400123');
    });

    it('throws TrustedPersonRevokedError when the whitelisted row is revoked', async () => {
      const w = wire();
      w.trustedPeople.put(
        makeTrustedPerson({ revokedAt: NOW, isActive: false }),
      );
      await expect(
        w.service.createByStaff(KG, STAFF_USER, {
          childId: CHILD,
          trustedPersonId: TP_ID,
        }),
      ).rejects.toBeInstanceOf(TrustedPersonRevokedError);
    });

    it('throws TrustedPersonNotForChildError when the whitelisted row is for a different child', async () => {
      const w = wire();
      w.trustedPeople.put(
        makeTrustedPerson({ childId: 'cccccccc-9999-9999-9999-999999999999' }),
      );
      await expect(
        w.service.createByStaff(KG, STAFF_USER, {
          childId: CHILD,
          trustedPersonId: TP_ID,
        }),
      ).rejects.toBeInstanceOf(TrustedPersonNotForChildError);
    });

    it('throws ChildNotFoundError when the child does not exist in this kg', async () => {
      const w = wire();
      await expect(
        w.service.createByStaff(KG, STAFF_USER, {
          childId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
          trustedPersonId: null,
          trustedPersonName: 'X',
          trustedPersonPhone: '+77000000000',
        }),
      ).rejects.toBeInstanceOf(ChildNotFoundError);
    });

    it('throws StaffNotFoundError when the caller is not staff in this kg', async () => {
      const w = wire();
      await expect(
        w.service.createByStaff(KG, 'no-such-user', {
          childId: CHILD,
          trustedPersonId: null,
          trustedPersonName: 'X',
          trustedPersonPhone: '+77000000000',
        }),
      ).rejects.toBeInstanceOf(StaffNotFoundError);
    });
  });

  describe('createByParent', () => {
    it('returns a request when the parent is an approved active pickup guardian', async () => {
      const w = wire();
      w.childGuardians.put(makeApprovedPickupGuardian());
      const pr = await w.service.createByParent(KG, PARENT_USER, {
        childId: CHILD,
        trustedPersonId: null,
        trustedPersonName: 'Aunt',
        trustedPersonPhone: '+77001112233',
      });
      expect(pr.requestedByUserId).toBe(PARENT_USER);
    });

    it('throws ForbiddenActionError when the parent has no pickup guardian link', async () => {
      const w = wire();
      // No guardian seeded.
      await expect(
        w.service.createByParent(KG, PARENT_USER, {
          childId: CHILD,
          trustedPersonId: null,
          trustedPersonName: 'Aunt',
          trustedPersonPhone: '+77001112233',
        }),
      ).rejects.toBeInstanceOf(ForbiddenActionError);
    });

    it('throws ForbiddenActionError when the parent guardian has can_pickup=false', async () => {
      const w = wire();
      w.childGuardians.put(makeApprovedPickupGuardian({ canPickup: false }));
      await expect(
        w.service.createByParent(KG, PARENT_USER, {
          childId: CHILD,
          trustedPersonId: null,
          trustedPersonName: 'Aunt',
          trustedPersonPhone: '+77001112233',
        }),
      ).rejects.toBeInstanceOf(ForbiddenActionError);
    });
  });

  describe('sendOtp', () => {
    async function seedRequest(w: Wired): Promise<PickupRequest> {
      return w.service.createByStaff(KG, STAFF_USER, {
        childId: CHILD,
        trustedPersonId: null,
        trustedPersonName: 'Aunt',
        trustedPersonPhone: TRUSTED_PHONE,
      });
    }

    it('returns otpRef + ttl, stores the code in Redis, sends SMS, fires pickup.otp_sent', async () => {
      const w = wire();
      const pr = await seedRequest(w);
      const result = await w.service.sendOtp(KG, pr.id);
      expect(result.expiresIn).toBe(1800);
      expect(result.otpRef).toBe(`otp:pickup:${pr.id}`);
      expect(w.otpStore.storeCalls).toHaveLength(1);
      expect(w.otpStore.storeCalls[0].requestId).toBe(pr.id);
      expect(w.otpStore.storeCalls[0].code).toMatch(/^\d{6}$/);
      expect(w.sms.sent).toHaveLength(1);
      expect(w.sms.sent[0].phone).toBe(TRUSTED_PHONE);
      expect(w.sms.sent[0].message).toContain(w.otpStore.storeCalls[0].code);
      expect(w.notifications.pickupOtpSent).toHaveLength(1);
      // pickup_request.otp_ref is stamped post-storeCode.
      const after = await w.pickupRequests.findById(pr.id);
      expect(after?.otpRef).toBe(result.otpRef);
    });

    it('throws OtpRateLimitedError when auth otp store flags exceeded', async () => {
      const w = wire();
      const pr = await seedRequest(w);
      w.authOtpStore.rateLimitState = 'exceeded';
      await expect(w.service.sendOtp(KG, pr.id)).rejects.toBeInstanceOf(
        OtpRateLimitedError,
      );
      expect(w.sms.sent).toHaveLength(0);
    });

    it('throws OtpLockedError when the request is locked', async () => {
      const w = wire();
      const pr = await seedRequest(w);
      w.otpStore.locks.add(pr.id);
      await expect(w.service.sendOtp(KG, pr.id)).rejects.toBeInstanceOf(
        OtpLockedError,
      );
      expect(w.sms.sent).toHaveLength(0);
    });

    it('does NOT consume an auth-shared rate-limit slot when the request is locked (T7 M4 fix — order: isLocked first, then rate-limit)', async () => {
      const w = wire();
      const pr = await seedRequest(w);
      w.otpStore.locks.add(pr.id);
      const beforeRate = w.authOtpStore.rateLimitCalls;
      await expect(w.service.sendOtp(KG, pr.id)).rejects.toBeInstanceOf(
        OtpLockedError,
      );
      expect(w.authOtpStore.rateLimitCalls).toBe(beforeRate);
    });

    it('continues to send OTP when the kg lookup fails (best-effort) — T7 M2', async () => {
      const w = wire();
      const pr = await seedRequest(w);
      w.kindergartenRepo.byId.clear();
      const result = await w.service.sendOtp(KG, pr.id);
      expect(result.expiresIn).toBe(1800);
      expect(w.sms.sent).toHaveLength(1);
      // SMS body falls back to literal placeholder when kg name is unknown.
      expect(w.sms.sent[0].message).toContain('детский сад');
    });

    it('continues to send OTP when the child lookup returns null (best-effort, T7 M2 — was throwing 404 silently)', async () => {
      const w = wire();
      const pr = await seedRequest(w);
      w.childRepo.byId.clear();
      const result = await w.service.sendOtp(KG, pr.id);
      expect(result.expiresIn).toBe(1800);
      expect(w.sms.sent).toHaveLength(1);
    });

    it('throws PickupRequestNotFoundError for unknown id', async () => {
      const w = wire();
      await expect(w.service.sendOtp(KG, 'nope')).rejects.toBeInstanceOf(
        PickupRequestNotFoundError,
      );
    });

    it('acquires the same advisory lock validateOtp/cancel use (T7-4 — serializes vs concurrent cancel/validate to avoid SMS sent for terminal request)', async () => {
      const w = wire();
      const pr = await seedRequest(w);
      await w.service.sendOtp(KG, pr.id);
      expect(w.pickupRequests.advisoryLockCalls).toContain(pr.id);
    });

    it('throws PickupRequestExpiredError (410) when the pickup_request has passed expires_at (T7-5 MEDIUM#5 — was 409 status_invalid before)', async () => {
      const w = wire();
      const pr = await seedRequest(w);
      // Advance the clock past expires_at (30 min later).
      w.clock.set(new Date(NOW.getTime() + 31 * 60 * 1000));
      await expect(w.service.sendOtp(KG, pr.id)).rejects.toBeInstanceOf(
        PickupRequestExpiredError,
      );
      expect(w.sms.sent).toHaveLength(0);
      expect(w.notifications.pickupOtpSent).toHaveLength(0);
    });

    it('throws PickupRequestStatusInvalidError when a concurrent path flipped the row out of otp_sent before the lock was acquired (T7-4 — re-check status under lock)', async () => {
      const w = wire();
      const pr = await seedRequest(w);
      // Simulate a concurrent cancel that snuck through before sendOtp grabs
      // the lock — flip the row to `cancelled` directly via the fake repo.
      await w.pickupRequests.update(pr.id, { status: 'cancelled' });
      await expect(w.service.sendOtp(KG, pr.id)).rejects.toBeInstanceOf(
        PickupRequestStatusInvalidError,
      );
      // SMS / outbox MUST NOT fire for a cancelled request.
      expect(w.sms.sent).toHaveLength(0);
      expect(w.notifications.pickupOtpSent).toHaveLength(0);
    });
  });

  describe('validateOtp', () => {
    async function seedAndSend(w: Wired): Promise<{
      pr: PickupRequest;
      code: string;
    }> {
      const pr = await w.service.createByStaff(KG, STAFF_USER, {
        childId: CHILD,
        trustedPersonId: null,
        trustedPersonName: 'Aunt',
        trustedPersonPhone: TRUSTED_PHONE,
      });
      await w.service.sendOtp(KG, pr.id);
      const code = w.otpStore.storeCalls[0].code;
      return { pr, code };
    }

    it('returns validated request + attendance event id, calls AttendanceService.checkOut with method=otp_pickup, fires pickup.validated', async () => {
      const w = wire();
      const { pr, code } = await seedAndSend(w);
      const result = await w.service.validateOtp(KG, pr.id, code, STAFF_USER);
      expect(result.attendanceEventId).toBe('evt-1');
      expect(result.pickupRequest.status).toBe('validated');
      expect(w.attendance.checkOutCalls).toHaveLength(1);
      const call = w.attendance.checkOutCalls[0];
      expect(call.kg).toBe(KG);
      expect(call.childId).toBe(CHILD);
      expect(call.callerUserId).toBe(STAFF_USER);
      expect(call.pickupUserId).toBeNull();
      expect(call.method).toBe('otp_pickup');
      expect(call.pickupRequestId).toBe(pr.id);
      expect(w.pickupRequests.advisoryLockCalls).toContain(pr.id);
      expect(w.notifications.pickupValidated).toHaveLength(1);
      // OTP cleared post-success.
      expect(await w.otpStore.readCode(pr.id)).toBeNull();
    });

    it('marks the trusted_people row as used (deactivate=true) when isOneTime=true', async () => {
      const w = wire();
      w.trustedPeople.put(makeTrustedPerson({ isOneTime: true }));
      const pr = await w.service.createByStaff(KG, STAFF_USER, {
        childId: CHILD,
        trustedPersonId: TP_ID,
      });
      await w.service.sendOtp(KG, pr.id);
      const code = w.otpStore.storeCalls[0].code;
      await w.service.validateOtp(KG, pr.id, code, STAFF_USER);
      expect(w.trustedPeople.markUsedCalls).toHaveLength(1);
      expect(w.trustedPeople.markUsedCalls[0]).toEqual({
        id: TP_ID,
        deactivate: true,
      });
    });

    it('marks the trusted_people row as used (deactivate=false) when isOneTime=false', async () => {
      const w = wire();
      w.trustedPeople.put(makeTrustedPerson({ isOneTime: false }));
      const pr = await w.service.createByStaff(KG, STAFF_USER, {
        childId: CHILD,
        trustedPersonId: TP_ID,
      });
      await w.service.sendOtp(KG, pr.id);
      const code = w.otpStore.storeCalls[0].code;
      await w.service.validateOtp(KG, pr.id, code, STAFF_USER);
      expect(w.trustedPeople.markUsedCalls[0]).toEqual({
        id: TP_ID,
        deactivate: false,
      });
    });

    it('fetches the trusted_person row at most once under the advisory lock (M18 double-fetch collapse)', async () => {
      const w = wire();
      w.trustedPeople.put(makeTrustedPerson({ isOneTime: true }));
      const pr = await w.service.createByStaff(KG, STAFF_USER, {
        childId: CHILD,
        trustedPersonId: TP_ID,
      });
      // The createByStaff path itself looks up the trusted_person for the
      // child-match check. Snapshot the counter at the start of validateOtp.
      w.trustedPeople.findByIdCalls.length = 0;
      await w.service.sendOtp(KG, pr.id);
      // sendOtp does not touch trusted_people.
      expect(w.trustedPeople.findByIdCalls).toHaveLength(0);
      const code = w.otpStore.storeCalls[0].code;
      await w.service.validateOtp(KG, pr.id, code, STAFF_USER);
      // Pre-T7: 2 fetches (pre-flight + pre-markUsed). Post-T7: exactly 1.
      expect(w.trustedPeople.findByIdCalls).toEqual([TP_ID]);
      // markUsed still fires with the correct (immutable) isOneTime flag.
      expect(w.trustedPeople.markUsedCalls[0]).toEqual({
        id: TP_ID,
        deactivate: true,
      });
    });

    it('throws OtpInvalidError on a wrong code, increments attempt counter, does not lock until 3rd failure', async () => {
      const w = wire();
      const { pr } = await seedAndSend(w);
      await expect(
        w.service.validateOtp(KG, pr.id, '000000', STAFF_USER),
      ).rejects.toBeInstanceOf(OtpInvalidError);
      await expect(
        w.service.validateOtp(KG, pr.id, '000000', STAFF_USER),
      ).rejects.toBeInstanceOf(OtpInvalidError);
      expect(w.otpStore.attempts.get(pr.id)).toBe(2);
      expect(w.otpStore.locks.has(pr.id)).toBe(false);
    });

    it('throws OtpLockedError on the 3rd consecutive wrong code and persists the lock', async () => {
      const w = wire();
      const { pr } = await seedAndSend(w);
      await expect(
        w.service.validateOtp(KG, pr.id, '000000', STAFF_USER),
      ).rejects.toBeInstanceOf(OtpInvalidError);
      await expect(
        w.service.validateOtp(KG, pr.id, '000000', STAFF_USER),
      ).rejects.toBeInstanceOf(OtpInvalidError);
      await expect(
        w.service.validateOtp(KG, pr.id, '000000', STAFF_USER),
      ).rejects.toBeInstanceOf(OtpLockedError);
      expect(w.otpStore.locks.has(pr.id)).toBe(true);
      expect(w.otpStore.lockCalls).toEqual([pr.id]);
    });

    it('throws PickupOtpExpiredError (410 otp_expired) when the Redis entry has been evicted (TTL expired) — T7-5 MEDIUM#5', async () => {
      const w = wire();
      const { pr, code } = await seedAndSend(w);
      w.otpStore.evict(pr.id);
      await expect(
        w.service.validateOtp(KG, pr.id, code, STAFF_USER),
      ).rejects.toBeInstanceOf(PickupOtpExpiredError);
    });

    it('throws PickupRequestAlreadyValidatedError on a re-submit of the same code (terminal-state guard)', async () => {
      const w = wire();
      const { pr, code } = await seedAndSend(w);
      await w.service.validateOtp(KG, pr.id, code, STAFF_USER);
      // Re-validate should hit the AlreadyValidated branch — note that
      // `seedAndSend` produced a single code; storing it again here is not
      // necessary because the entity status is already `validated`.
      await expect(
        w.service.validateOtp(KG, pr.id, code, STAFF_USER),
      ).rejects.toBeInstanceOf(PickupRequestAlreadyValidatedError);
    });

    it('throws StaffNotFoundError when the caller has no staff_member row', async () => {
      const w = wire();
      const { pr, code } = await seedAndSend(w);
      await expect(
        w.service.validateOtp(KG, pr.id, code, 'unknown-user'),
      ).rejects.toBeInstanceOf(StaffNotFoundError);
    });

    it('throws TrustedPersonRevokedError when the trusted_people row was revoked between create and validate (T7-5 HIGH#1 — re-check after lock)', async () => {
      const w = wire();
      // Seed a fresh whitelisted tp, create + send-otp.
      w.trustedPeople.put(makeTrustedPerson({ isOneTime: false }));
      const pr = await w.service.createByStaff(KG, STAFF_USER, {
        childId: CHILD,
        trustedPersonId: TP_ID,
      });
      await w.service.sendOtp(KG, pr.id);
      const code = w.otpStore.storeCalls[0].code;

      // Simulate a parent revoke between create and validate.
      const tp = w.trustedPeople.rows.get(TP_ID);
      if (!tp) throw new Error('test seed lost the tp row');
      w.trustedPeople.rows.set(TP_ID, tp.revoke(NOW));

      await expect(
        w.service.validateOtp(KG, pr.id, code, STAFF_USER),
      ).rejects.toBeInstanceOf(TrustedPersonRevokedError);
      // No attendance side-effect ran.
      expect(w.attendance.checkOutCalls).toHaveLength(0);
    });

    it('throws TrustedPersonRevokedError when concurrent markUsed lost the claim race on a one-time row (T7-5 HIGH#2)', async () => {
      const w = wire();
      w.trustedPeople.put(makeTrustedPerson({ isOneTime: true }));
      const pr = await w.service.createByStaff(KG, STAFF_USER, {
        childId: CHILD,
        trustedPersonId: TP_ID,
      });
      await w.service.sendOtp(KG, pr.id);
      const code = w.otpStore.storeCalls[0].code;
      // Force the next markUsed to behave as the race loser.
      w.trustedPeople.markUsedNextResult = false;
      await expect(
        w.service.validateOtp(KG, pr.id, code, STAFF_USER),
      ).rejects.toBeInstanceOf(TrustedPersonRevokedError);
      // Service did go far enough to call markUsed (claim attempt).
      expect(w.trustedPeople.markUsedCalls).toHaveLength(1);
      expect(w.trustedPeople.markUsedCalls[0]).toEqual({
        id: TP_ID,
        deactivate: true,
      });
    });
  });

  describe('cancel', () => {
    it('returns a cancelled request and clears the OTP cache key when otp_ref was set', async () => {
      const w = wire();
      const pr = await w.service.createByStaff(KG, STAFF_USER, {
        childId: CHILD,
        trustedPersonId: null,
        trustedPersonName: 'Aunt',
        trustedPersonPhone: TRUSTED_PHONE,
      });
      await w.service.sendOtp(KG, pr.id);
      const cancelled = await w.service.cancel(KG, pr.id);
      expect(cancelled.status).toBe('cancelled');
      expect(await w.otpStore.readCode(pr.id)).toBeNull();
    });

    it('acquires the same advisory lock validateOtp uses (T7 H3 — serializes vs concurrent validate)', async () => {
      const w = wire();
      const pr = await w.service.createByStaff(KG, STAFF_USER, {
        childId: CHILD,
        trustedPersonId: null,
        trustedPersonName: 'Aunt',
        trustedPersonPhone: TRUSTED_PHONE,
      });
      await w.service.cancel(KG, pr.id);
      expect(w.pickupRequests.advisoryLockCalls).toContain(pr.id);
    });

    it('clears the OTP cache key unconditionally even when otp_ref is null (T7 H5 — defensive cleanup vs in-flight send-otp)', async () => {
      const w = wire();
      const pr = await w.service.createByStaff(KG, STAFF_USER, {
        childId: CHILD,
        trustedPersonId: null,
        trustedPersonName: 'Aunt',
        trustedPersonPhone: TRUSTED_PHONE,
      });
      // Simulate a phantom OTP entry that was written (e.g. by a concurrent
      // send-otp) AFTER cancel reads the row but before the DB UPDATE.
      // Without the unconditional clearCode the entry would leak.
      w.otpStore.codes.set(pr.id, { code: '999999', attempts: 0 });
      await w.service.cancel(KG, pr.id);
      expect(await w.otpStore.readCode(pr.id)).toBeNull();
    });

    it('throws PickupRequestStatusInvalidError when a concurrent path flipped the row out of otp_sent (T7 H3 — expectedStatus repo guard)', async () => {
      const w = wire();
      const pr = await w.service.createByStaff(KG, STAFF_USER, {
        childId: CHILD,
        trustedPersonId: null,
        trustedPersonName: 'Aunt',
        trustedPersonPhone: TRUSTED_PHONE,
      });
      await w.service.sendOtp(KG, pr.id);
      // Simulate a concurrent validate that snuck through the lock window —
      // we manually flip status to validated BEFORE cancel runs. The
      // domain-level entity guard at `pr.cancel(now)` and/or the
      // expectedStatus='otp_sent' repo guard should both reject.
      const code = w.otpStore.storeCalls[0].code;
      await w.service.validateOtp(KG, pr.id, code, STAFF_USER);
      // Now `pr` is in `validated`. Cancel should observe the conflict.
      await expect(w.service.cancel(KG, pr.id)).rejects.toBeInstanceOf(
        PickupRequestStatusInvalidError,
      );
    });

    it('throws PickupRequestNotFoundError for an unknown id', async () => {
      const w = wire();
      await expect(w.service.cancel(KG, 'nope')).rejects.toBeInstanceOf(
        PickupRequestNotFoundError,
      );
    });
  });

  describe('listByKindergarten / getById', () => {
    it('returns rows under the same kg', async () => {
      const w = wire();
      await w.service.createByStaff(KG, STAFF_USER, {
        childId: CHILD,
        trustedPersonId: null,
        trustedPersonName: 'A',
        trustedPersonPhone: TRUSTED_PHONE,
      });
      const rows = await w.service.listByKindergarten(KG, {});
      expect(rows).toHaveLength(1);
    });

    it('throws PickupRequestNotFoundError for cross-tenant id', async () => {
      const w = wire();
      const pr = await w.service.createByStaff(KG, STAFF_USER, {
        childId: CHILD,
        trustedPersonId: null,
        trustedPersonName: 'A',
        trustedPersonPhone: TRUSTED_PHONE,
      });
      await expect(
        w.service.getById('99999999-9999-9999-9999-999999999999', pr.id),
      ).rejects.toBeInstanceOf(PickupRequestNotFoundError);
    });
  });
});
