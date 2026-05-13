/**
 * ParentRequestService — service-unit suite. Hand-written in-memory fakes for
 * every collaborator (no Jest auto-mock), per CLAUDE.md §7.
 *
 * Coverage matrix (master plan §7 + §8 K-section):
 *   1.  sendOtpForTrustedPerson — happy path, rate-limit hit, locked-out.
 *   2.  createTrustedPersonRequest — valid code, wrong/expired/locked code.
 *   3.  createDayOff — 1 weekend, 2 same-week, weekday/different-week/past-date rejections.
 *   4.  createVacation — date_from > date_to, past date_from, happy path.
 *   5.  createLatePickup — invalid HH:MM, past date, happy path.
 *   6.  createOpen — specialist branch validation; mentor explicit / fallback.
 *   7.  cancelRequest — happy, accepted → 409, non-requester → 403.
 *   8.  acceptRequest — happy + side-effects, accepted → 409,
 *                       trusted_person side-effect creates trusted_people row,
 *                       create_pickup_request=true → also pickup_requests row.
 *   9.  rejectRequest — happy.
 *   10. addParentMessage / addStaffMessage — XOR author, notification dispatch.
 *   11. listForParent / listForStaffInbox / listAllForAdmin — basic shape.
 *   12. getByIdForParent / getByIdForStaff — auth checks.
 *   13. permissions — create_requests=false → 403 on every create endpoint.
 *   14. cross-tenant phantom — kg mismatch returns 404 via repo filter.
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
  ParentRequestAcceptedEvent,
  ParentRequestCancelledEvent,
  ParentRequestMessageSentEvent,
  ParentRequestRejectedEvent,
  PermissionsUpdatedEvent,
  PickupOtpSentEvent,
  PickupValidatedEvent,
  TimelineEntryCreatedEvent,
} from '@/common/notifications/notification.port';
import {
  Invoice,
  InvoiceState,
} from '@/modules/billing/domain/entities/invoice.entity';
import { TariffPlanNotFoundError } from '@/modules/billing/domain/errors/tariff-plan-not-found.error';
import { InvoiceService } from '@/modules/billing/invoice.service';
import { MoneyKzt } from '@/shared-kernel/domain/money-kzt';
import { OtpInvalidError } from '@/modules/auth/domain/errors/otp-invalid.error';
import { OtpExpiredError } from '@/modules/auth/domain/errors/otp-expired.error';
import { OtpLockedError } from '@/modules/auth/domain/errors/otp-locked.error';
import { OtpRateLimitedError } from '@/modules/auth/domain/errors/otp-rate-limited.error';
import { OtpStorePort, StoredOtp } from '@/modules/auth/otp-store.port';
import { SmsPort } from '@/modules/auth/sms.port';
import { Child } from '@/modules/child/domain/entities/child.entity';
import { ChildGuardian } from '@/modules/child/domain/entities/child-guardian.entity';
import { ChildGuardianRepository } from '@/modules/child/infrastructure/persistence/child-guardian.repository';
import {
  ChildGroupHistoryRecord,
  ChildListFilters,
  ChildRepository,
  PageRequest,
  PageResult,
} from '@/modules/child/infrastructure/persistence/child.repository';
import { Group } from '@/modules/group/domain/entities/group.entity';
import { GroupMentor } from '@/modules/group/domain/entities/group-mentor.entity';
import {
  CreateGroupInput,
  GroupRepository,
  ListGroupsFilters,
  UpdateGroupInput,
} from '@/modules/group/infrastructure/persistence/group.repository';
import { TrustedPerson } from '@/modules/pickup/domain/entities/trusted-person.entity';
import {
  CreatePickupRequestRow,
  ListPickupFilters,
  PickupRequestPatch,
  PickupRequestRepository,
  PickupRequestUpdateOpts,
} from '@/modules/pickup/infrastructure/persistence/pickup-request.repository';
import { PickupRequest } from '@/modules/pickup/domain/entities/pickup-request.entity';
import {
  CreateTrustedPersonRow,
  TrustedPersonPatch,
  TrustedPersonRepository,
} from '@/modules/pickup/infrastructure/persistence/trusted-person.repository';
import { StaffMember } from '@/modules/staff/domain/entities/staff-member.entity';
import {
  CreateStaffMemberInput,
  ListStaffFilters,
  StaffMemberRepository,
  UpdateStaffMemberInput,
} from '@/modules/staff/infrastructure/persistence/staff-member.repository';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import {
  ParentRequest,
  ParentRequestState,
  ParentRequestStatus,
} from './domain/entities/parent-request.entity';
import { ParentRequestMessage } from './domain/entities/parent-request-message.entity';
import {
  CreateRequestPermissionRequiredError,
  ParentRequestAlreadyProcessedError,
  ParentRequestForbiddenError,
  ParentRequestNotFoundError,
} from './domain/errors';
import {
  ParentRequestOtpStorePort,
  StoredParentRequestOtp,
} from './infrastructure/otp/parent-request-otp-store.port';
import {
  CreateParentRequestInput,
  ListParentRequestsFilter,
  ParentRequestRepository,
} from './parent-request.repository';
import {
  CreateParentRequestMessageInput,
  ParentRequestMessageRepository,
} from './parent-request-message.repository';
import { ParentRequestService } from './parent-request.service';
import { InvariantViolationError } from '@/shared-kernel/domain/errors';

// ── Constants ────────────────────────────────────────────────────────────

const KG = '11111111-1111-1111-1111-111111111111';
const KG_OTHER = '22222222-2222-2222-2222-222222222222';
const CHILD = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const CHILD_OTHER = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const PARENT_USER = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa';
const OTHER_PARENT_USER = 'aaaaaaaa-3333-3333-3333-aaaaaaaaaaaa';
const STAFF_USER = 'aaaaaaaa-2222-2222-2222-aaaaaaaaaaaa';
const STAFF_USER_OTHER = 'aaaaaaaa-4444-4444-4444-aaaaaaaaaaaa';
const STAFF_MENTOR_ID = 'bbbbbbbb-1111-2222-3333-bbbbbbbbbbbb';
const STAFF_OTHER_MENTOR_ID = 'bbbbbbbb-9999-9999-9999-bbbbbbbbbbbb';
const STAFF_SPECIALIST_ID = 'bbbbbbbb-2222-3333-4444-bbbbbbbbbbbb';
const STAFF_ADMIN_ID = 'bbbbbbbb-3333-4444-5555-bbbbbbbbbbbb';
const GROUP_ID = 'gggggggg-1111-2222-3333-gggggggggggg';
const PHONE = '+77071234567';

// Sat 2026-05-09 (UTC) — used as a base "today" so weekend dates are in future
const NOW = new Date('2026-05-04T09:00:00.000Z'); // Monday

// ── FakeClock ────────────────────────────────────────────────────────────

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

// ── Fake repositories / ports ────────────────────────────────────────────

class FakeParentRequestRepo extends ParentRequestRepository {
  rows = new Map<string, ParentRequest>();
  private nextId = 0;
  /**
   * Optional resolver mirroring the relational repo's INNER JOIN on
   * `children.current_group_id`. Set by the harness so the in-memory list()
   * can honour `filter.groupId`.
   */
  resolveChildGroupId: (childId: string) => string | null = () => null;

  put(pr: ParentRequest): void {
    this.rows.set(pr.id, pr);
  }

  create(input: CreateParentRequestInput): Promise<ParentRequest> {
    const id = `pr-${++this.nextId}`;
    const state: ParentRequestState = {
      id,
      kindergartenId: input.kindergartenId,
      childId: input.childId,
      requesterUserId: input.requesterUserId,
      requestType: input.requestType,
      status: 'pending',
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      details: input.details,
      recipientType: input.recipientType,
      recipientStaffId: input.recipientStaffId,
      reviewedBy: null,
      reviewedAt: null,
      reviewNote: null,
      invoiceId: null,
      createdAt: new Date(NOW.getTime()),
      updatedAt: new Date(NOW.getTime()),
    };
    const pr = ParentRequest.fromState(state);
    this.rows.set(id, pr);
    return Promise.resolve(pr);
  }

  findById(id: string, kindergartenId: string): Promise<ParentRequest | null> {
    const pr = this.rows.get(id);
    if (!pr || pr.kindergartenId !== kindergartenId) {
      return Promise.resolve(null);
    }
    return Promise.resolve(pr);
  }

  list(filter: ListParentRequestsFilter): Promise<ParentRequest[]> {
    const all = [...this.rows.values()].filter((pr) => {
      if (pr.kindergartenId !== filter.kindergartenId) return false;
      if (filter.status && pr.status !== filter.status) return false;
      if (filter.requestType && pr.requestType !== filter.requestType)
        return false;
      if (filter.childId && pr.childId !== filter.childId) return false;
      if (
        filter.groupId &&
        this.resolveChildGroupId(pr.childId) !== filter.groupId
      ) {
        return false;
      }
      if (
        filter.requesterUserId &&
        pr.requesterUserId !== filter.requesterUserId
      )
        return false;
      if (
        filter.recipientStaffId &&
        pr.recipientStaffId !== filter.recipientStaffId
      )
        return false;
      if (filter.recipientType && pr.recipientType !== filter.recipientType)
        return false;
      return true;
    });
    // B22b T7 M16: mirror the relational repo's (created_at DESC, id DESC)
    // ordering + composite cursor predicate so the service-spec exercises
    // the same pagination contract.
    all.sort((a, b) => {
      const at = b.createdAt.getTime() - a.createdAt.getTime();
      if (at !== 0) return at;
      return b.id.localeCompare(a.id);
    });
    let scoped = all;
    if (filter.cursor) {
      const cursorAtTs = filter.cursor.createdAt.getTime();
      const cursorId = filter.cursor.id;
      scoped = all.filter((pr) => {
        const atTs = pr.createdAt.getTime();
        if (atTs < cursorAtTs) return true;
        if (atTs === cursorAtTs && pr.id.localeCompare(cursorId) < 0)
          return true;
        return false;
      });
    }
    if (filter.limit !== undefined) {
      scoped = scoped.slice(0, filter.limit);
    }
    return Promise.resolve(scoped);
  }

  updateStatusConditional(
    id: string,
    kindergartenId: string,
    expectedStatus: ParentRequestStatus,
    nextStatus: ParentRequestStatus,
    patch: {
      reviewedBy?: string | null;
      reviewedAt?: Date | null;
      reviewNote?: string | null;
      updatedAt: Date;
    },
  ): Promise<ParentRequest | null> {
    const pr = this.rows.get(id);
    if (!pr || pr.kindergartenId !== kindergartenId) {
      return Promise.resolve(null);
    }
    if (pr.status !== expectedStatus) return Promise.resolve(null);
    const s = pr.toState();
    const next = ParentRequest.fromState({
      ...s,
      status: nextStatus,
      reviewedBy: patch.reviewedBy ?? null,
      reviewedAt: patch.reviewedAt ?? null,
      reviewNote: patch.reviewNote ?? null,
      updatedAt: patch.updatedAt,
    });
    this.rows.set(id, next);
    return Promise.resolve(next);
  }

  setInvoiceIdCalls: Array<{
    kg: string;
    parentRequestId: string;
    invoiceId: string;
  }> = [];

  setInvoiceId(
    kindergartenId: string,
    parentRequestId: string,
    invoiceId: string,
  ): Promise<void> {
    this.setInvoiceIdCalls.push({
      kg: kindergartenId,
      parentRequestId,
      invoiceId,
    });
    const pr = this.rows.get(parentRequestId);
    if (!pr || pr.kindergartenId !== kindergartenId) {
      return Promise.reject(new ParentRequestNotFoundError(parentRequestId));
    }
    const next = ParentRequest.fromState({ ...pr.toState(), invoiceId });
    this.rows.set(parentRequestId, next);
    return Promise.resolve();
  }
}

class FakeMessageRepo extends ParentRequestMessageRepository {
  rows = new Map<string, ParentRequestMessage>();
  private nextId = 0;

  create(
    input: CreateParentRequestMessageInput,
  ): Promise<ParentRequestMessage> {
    const id = `m-${++this.nextId}`;
    const m = ParentRequestMessage.fromState({
      id,
      kindergartenId: input.kindergartenId,
      parentRequestId: input.parentRequestId,
      authorUserId: input.authorUserId,
      authorStaffId: input.authorStaffId,
      body: input.body,
      attachments: input.attachments,
      createdAt: new Date(NOW.getTime() + this.rows.size),
    });
    this.rows.set(id, m);
    return Promise.resolve(m);
  }

  listByRequestId(
    parentRequestId: string,
    kindergartenId: string,
    limit: number,
    cursor: string | null,
  ): Promise<ParentRequestMessage[]> {
    const list = [...this.rows.values()]
      .filter(
        (m) =>
          m.parentRequestId === parentRequestId &&
          m.kindergartenId === kindergartenId,
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const filtered = cursor
      ? list.filter((m) => m.createdAt.toISOString() > cursor)
      : list;
    return Promise.resolve(filtered.slice(0, limit));
  }
}

class FakeChildGuardianRepo extends ChildGuardianRepository {
  guardians: ChildGuardian[] = [];

  put(g: ChildGuardian): void {
    this.guardians.push(g);
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
  findApprovedActivePickupGuardian(): Promise<ChildGuardian | null> {
    return Promise.resolve(null);
  }
  findApprovedActiveByUserIdCrossTenant(): Promise<ChildGuardian[]> {
    return Promise.resolve([]);
  }
  findApprovedActiveByUserAndChild(
    kg: string,
    childId: string,
    userId: string,
  ): Promise<ChildGuardian | null> {
    const g =
      this.guardians.find((x) => {
        const s = x.toState();
        return (
          s.kindergartenId === kg &&
          s.childId === childId &&
          s.userId === userId &&
          s.status === 'approved' &&
          s.revokedAt === null
        );
      }) ?? null;
    return Promise.resolve(g);
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

class FakeStaffRepo extends StaffMemberRepository {
  byUserKg = new Map<string, StaffMember>();
  byId = new Map<string, StaffMember>();
  put(s: StaffMember): void {
    this.byUserKg.set(`${s.kindergartenId}|${s.userId}`, s);
    this.byId.set(s.id, s);
  }
  create(_input: CreateStaffMemberInput): Promise<StaffMember> {
    throw new Error('not used');
  }
  findById(_kg: string, id: string): Promise<StaffMember | null> {
    return Promise.resolve(this.byId.get(id) ?? null);
  }
  findActiveByUserAndKindergarten(
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

class FakeGroupRepo extends GroupRepository {
  activeMentors = new Map<string, GroupMentor>(); // groupId → mentor
  putMentor(groupId: string, mentor: GroupMentor): void {
    this.activeMentors.set(groupId, mentor);
  }

  create(_kg: string, _input: CreateGroupInput): Promise<Group> {
    throw new Error('not used');
  }
  findById(): Promise<Group | null> {
    return Promise.resolve(null);
  }
  list(_kg: string, _f?: ListGroupsFilters): Promise<Group[]> {
    return Promise.resolve([]);
  }
  update(
    _kg: string,
    _id: string,
    _patch: UpdateGroupInput,
  ): Promise<Group | null> {
    return Promise.resolve(null);
  }
  save(g: Group): Promise<Group> {
    return Promise.resolve(g);
  }
  assignMentor(): Promise<GroupMentor> {
    throw new Error('not used');
  }
  unassignMentor(): Promise<GroupMentor | null> {
    return Promise.resolve(null);
  }
  unassignMentorByStaffMember(): Promise<number> {
    return Promise.resolve(0);
  }
  findActiveMentor(_kg: string, groupId: string): Promise<GroupMentor | null> {
    return Promise.resolve(this.activeMentors.get(groupId) ?? null);
  }
  listMentorHistory(): Promise<GroupMentor[]> {
    return Promise.resolve([]);
  }
  findActiveMentorAssignmentsByUserIdCrossTenant(): Promise<GroupMentor[]> {
    return Promise.resolve([]);
  }
}

class FakeTrustedPersonRepo extends TrustedPersonRepository {
  rows: TrustedPerson[] = [];
  createCalls: CreateTrustedPersonRow[] = [];

  create(input: CreateTrustedPersonRow): Promise<TrustedPerson> {
    this.createCalls.push(input);
    const tp = TrustedPerson.create({
      id: `tp-${this.rows.length + 1}`,
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
    this.rows.push(tp);
    return Promise.resolve(tp);
  }
  findById(id: string): Promise<TrustedPerson | null> {
    return Promise.resolve(this.rows.find((r) => r.id === id) ?? null);
  }
  listByChild(): Promise<TrustedPerson[]> {
    return Promise.resolve([...this.rows]);
  }
  update(
    _id: string,
    _patch: TrustedPersonPatch,
  ): Promise<TrustedPerson | null> {
    return Promise.resolve(null);
  }
  markRevoked(): Promise<void> {
    return Promise.resolve();
  }
  markUsed(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

class FakePickupRepo extends PickupRequestRepository {
  rows: PickupRequest[] = [];
  createCalls: CreatePickupRequestRow[] = [];

  create(input: CreatePickupRequestRow): Promise<PickupRequest> {
    this.createCalls.push(input);
    const pr = PickupRequest.create({
      id: `pickup-${this.rows.length + 1}`,
      kindergartenId: input.kindergartenId,
      childId: input.childId,
      requestedByUserId: input.requestedByUserId,
      trustedPersonId: input.trustedPersonId,
      trustedPersonPhone: input.trustedPersonPhone,
      trustedPersonName: input.trustedPersonName,
      trustedPersonIin: input.trustedPersonIin,
      expiresAt: input.expiresAt,
      parentRequestId: input.parentRequestId ?? null,
      createdAt: NOW,
    });
    this.rows.push(pr);
    return Promise.resolve(pr);
  }
  findById(id: string): Promise<PickupRequest | null> {
    return Promise.resolve(this.rows.find((r) => r.id === id) ?? null);
  }
  findByIdForUpdate(): Promise<PickupRequest | null> {
    return Promise.resolve(null);
  }
  listByKindergarten(_f: ListPickupFilters): Promise<PickupRequest[]> {
    return Promise.resolve([]);
  }
  update(
    _id: string,
    _patch: PickupRequestPatch,
    _opts?: PickupRequestUpdateOpts,
  ): Promise<boolean> {
    return Promise.resolve(true);
  }
  acquireValidateAdvisoryLock(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeParentRequestOtpStore extends ParentRequestOtpStorePort {
  codes = new Map<string, StoredParentRequestOtp>();
  locks = new Set<string>();
  attempts = new Map<string, number>();

  storeCode(userId: string, code: string, _ttl: number): Promise<string> {
    this.codes.set(userId, { code, attempts: 0 });
    this.attempts.set(userId, 0);
    return Promise.resolve(`otp:request:trusted-person:${userId}`);
  }
  readCode(userId: string): Promise<StoredParentRequestOtp | null> {
    return Promise.resolve(this.codes.get(userId) ?? null);
  }
  clearCode(userId: string): Promise<void> {
    this.codes.delete(userId);
    return Promise.resolve();
  }
  incrementAttempts(userId: string): Promise<number> {
    const next = (this.attempts.get(userId) ?? 0) + 1;
    this.attempts.set(userId, next);
    return Promise.resolve(next);
  }
  lockUser(userId: string, _ttl: number): Promise<void> {
    this.locks.add(userId);
    return Promise.resolve();
  }
  isLocked(userId: string): Promise<boolean> {
    return Promise.resolve(this.locks.has(userId));
  }
}

class FakeAuthOtpStore extends OtpStorePort {
  rateLimitState: 'ok' | 'exceeded' = 'ok';
  rateLimitGenericState: 'ok' | 'exceeded' = 'ok';
  rateLimitGenericCalls: string[] = [];

  checkRateLimit(): Promise<'ok' | 'exceeded'> {
    return Promise.resolve(this.rateLimitState);
  }
  checkRateLimitGeneric(key: string): Promise<'ok' | 'exceeded'> {
    this.rateLimitGenericCalls.push(key);
    return Promise.resolve(this.rateLimitGenericState);
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
  acceptedEvents: ParentRequestAcceptedEvent[] = [];
  rejectedEvents: ParentRequestRejectedEvent[] = [];
  cancelledEvents: ParentRequestCancelledEvent[] = [];
  messageSentEvents: ParentRequestMessageSentEvent[] = [];

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
  notifyPickupOtpSent(_e: PickupOtpSentEvent): Promise<void> {
    return Promise.resolve();
  }
  notifyPickupValidated(_e: PickupValidatedEvent): Promise<void> {
    return Promise.resolve();
  }
  notifyParentRequestAccepted(e: ParentRequestAcceptedEvent): Promise<void> {
    this.acceptedEvents.push(e);
    return Promise.resolve();
  }
  notifyParentRequestRejected(e: ParentRequestRejectedEvent): Promise<void> {
    this.rejectedEvents.push(e);
    return Promise.resolve();
  }
  notifyParentRequestCancelled(e: ParentRequestCancelledEvent): Promise<void> {
    this.cancelledEvents.push(e);
    return Promise.resolve();
  }
  notifyParentRequestMessageSent(
    e: ParentRequestMessageSentEvent,
  ): Promise<void> {
    this.messageSentEvents.push(e);
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

/**
 * In-memory stub of InvoiceService — only `generateLatePickupInvoice` is
 * exercised by ParentRequestService. Captures call args; either returns a
 * deterministic Invoice POJO or throws the configured error so the
 * accept(late_pickup) branch can exercise the rollback path.
 */
interface GenerateLatePickupInvoiceCall {
  kindergartenId: string;
  childId: string;
  parentRequestId: string;
  expectedTime: string;
  actualTime: string;
  date: Date;
  requestedBy: string;
  lateFeeAmountKzt: number | undefined;
}

class StubInvoiceService {
  generateLatePickupInvoiceCalls: GenerateLatePickupInvoiceCall[] = [];
  generateFirstInvoiceCalls: number = 0;
  errorToThrow: Error | null = null;

  generateLatePickupInvoice = (
    kindergartenId: string,
    input: {
      childId: string;
      parentRequestId: string;
      expectedTime: string;
      actualTime: string;
      date: Date;
      requestedBy: string;
      lateFeeAmountKzt?: number;
    },
  ): Promise<Invoice> => {
    this.generateLatePickupInvoiceCalls.push({
      kindergartenId,
      childId: input.childId,
      parentRequestId: input.parentRequestId,
      expectedTime: input.expectedTime,
      actualTime: input.actualTime,
      date: input.date,
      requestedBy: input.requestedBy,
      lateFeeAmountKzt: input.lateFeeAmountKzt,
    });
    if (this.errorToThrow) return Promise.reject(this.errorToThrow);
    const invoiceId = `fake-invoice-id-${input.parentRequestId}`;
    const state: InvoiceState = {
      id: invoiceId,
      kindergartenId,
      childId: input.childId,
      paymentAccountId: `pa-${input.childId}`,
      tariffPlanId: 'tariff-late-pickup',
      invoiceType: 'late_pickup_fee',
      periodStart: input.date,
      periodEnd: input.date,
      amountDue: MoneyKzt.fromKzt(5000),
      discountPct: null,
      discountReason: null,
      amountAfterDiscount: MoneyKzt.fromKzt(5000),
      status: 'pending',
      dueDate: input.date,
      description: null,
      proratedForDays: null,
      createdAt: input.date,
      updatedAt: input.date,
    };
    return Promise.resolve(Invoice.fromState(state));
  };

  // Not used by ParentRequestService, but present so the cast through
  // `as unknown as InvoiceService` does not lose this method's signature
  // for any future reuse.
  generateFirstInvoice = (): Promise<Invoice> => {
    this.generateFirstInvoiceCalls++;
    return Promise.reject(new Error('not used'));
  };
}

// ── helpers ──────────────────────────────────────────────────────────────

function makeChild(opts: { id?: string; groupId?: string | null } = {}): Child {
  return Child.hydrate({
    id: opts.id ?? CHILD,
    kindergartenId: KG,
    iin: null,
    fullName: 'Test Child',
    dateOfBirth: new Date('2022-01-01'),
    gender: null,
    photoUrl: null,
    status: 'active',
    currentGroupId: opts.groupId === undefined ? GROUP_ID : opts.groupId,
    enrollmentDate: NOW,
    archivedAt: null,
    archiveReason: null,
    medicalNotes: null,
    allergyNotes: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function makeApprovedGuardian(
  userId: string,
  childId = CHILD,
  permissions: Record<string, boolean> = {},
  role: 'primary' | 'secondary' | 'nanny' = 'primary',
): ChildGuardian {
  return ChildGuardian.hydrate({
    id: `g-${userId}-${childId}`,
    kindergartenId: KG,
    childId,
    userId,
    role,
    status: 'approved',
    hasApprovalRights: true,
    approvedBy: userId,
    approvedAt: NOW,
    revokedBy: null,
    revokedAt: null,
    canPickup: true,
    permissions,
    permissionsUpdatedBy: null,
    permissionsUpdatedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function makeStaff(opts: {
  id: string;
  userId: string;
  role: 'admin' | 'mentor' | 'specialist' | 'reception';
  specialistType?: 'speech_therapist' | 'psychologist' | null;
}): StaffMember {
  return StaffMember.hydrate({
    id: opts.id,
    kindergartenId: KG,
    userId: opts.userId,
    fullName: 'Test Staff',
    phone: '+77070000000',
    role: opts.role,
    specialistType:
      opts.role === 'specialist'
        ? (opts.specialistType ?? 'speech_therapist')
        : null,
    isActive: true,
    hiredAt: NOW,
    firedAt: null,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function makeMentor(staffMemberId: string): GroupMentor {
  return GroupMentor.hydrate({
    id: `gm-${staffMemberId}`,
    kindergartenId: KG,
    groupId: GROUP_ID,
    staffMemberId,
    isPrimary: true,
    assignedAt: NOW,
    unassignedAt: null,
    createdAt: NOW,
  });
}

function buildHarness() {
  const clock = new FixedClock(NOW);
  const parentRequestRepo = new FakeParentRequestRepo();
  const messageRepo = new FakeMessageRepo();
  const guardianRepo = new FakeChildGuardianRepo();
  const childRepo = new FakeChildRepo();
  const staffRepo = new FakeStaffRepo();
  const groupRepo = new FakeGroupRepo();
  const tpRepo = new FakeTrustedPersonRepo();
  const pickupRepo = new FakePickupRepo();
  const otpStore = new FakeParentRequestOtpStore();
  const authOtpStore = new FakeAuthOtpStore();
  const sms = new FakeSmsPort();
  const notify = new FakeNotificationPort();
  const invoiceService = new StubInvoiceService();

  // Default permission set (primary): create_requests=true.
  const PRIMARY_PERMS = {}; // empty — defaults for primary include create_requests=true.
  const NANNY_PERMS = {}; // empty — nanny defaults to create_requests=false.

  guardianRepo.put(makeApprovedGuardian(PARENT_USER, CHILD, PRIMARY_PERMS));
  childRepo.put(makeChild());

  // Mirror relational repo's INNER JOIN children on current_group_id for
  // groupId filter (M2 from T7 codex review).
  parentRequestRepo.resolveChildGroupId = (childId: string) => {
    const c = childRepo.byId.get(childId);
    return c ? (c.toState().currentGroupId ?? null) : null;
  };

  staffRepo.put(
    makeStaff({ id: STAFF_MENTOR_ID, userId: STAFF_USER, role: 'mentor' }),
  );
  staffRepo.put(
    makeStaff({
      id: STAFF_OTHER_MENTOR_ID,
      userId: STAFF_USER_OTHER,
      role: 'mentor',
    }),
  );
  staffRepo.put(
    makeStaff({
      id: STAFF_SPECIALIST_ID,
      userId: 'aaaaaaaa-5555-5555-5555-aaaaaaaaaaaa',
      role: 'specialist',
    }),
  );
  staffRepo.put(
    makeStaff({
      id: STAFF_ADMIN_ID,
      userId: 'aaaaaaaa-6666-6666-6666-aaaaaaaaaaaa',
      role: 'admin',
    }),
  );

  groupRepo.putMentor(GROUP_ID, makeMentor(STAFF_MENTOR_ID));

  const config = {
    getOrThrow: jest.fn((key: string) => {
      if (key === 'auth.rateLimitOtpRequestLimit') return 5;
      if (key === 'auth.rateLimitOtpRequestWindowSec') return 3600;
      throw new Error(`unexpected config key ${key}`);
    }),
  } as unknown as ConfigService;

  const service = new ParentRequestService(
    parentRequestRepo,
    messageRepo,
    guardianRepo,
    childRepo,
    staffRepo,
    groupRepo,
    tpRepo,
    pickupRepo,
    otpStore,
    authOtpStore,
    sms,
    notify,
    clock,
    config,
    invoiceService as unknown as InvoiceService,
  );

  return {
    service,
    clock,
    parentRequestRepo,
    messageRepo,
    guardianRepo,
    childRepo,
    staffRepo,
    groupRepo,
    tpRepo,
    pickupRepo,
    otpStore,
    authOtpStore,
    sms,
    notify,
    invoiceService,
    PRIMARY_PERMS,
    NANNY_PERMS,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('ParentRequestService', () => {
  describe('sendOtpForTrustedPerson', () => {
    it('stores code, sends SMS, returns otp_ref + expiresIn', async () => {
      const h = buildHarness();
      const res = await h.service.sendOtpForTrustedPerson(
        KG,
        PARENT_USER,
        CHILD,
        PHONE,
      );
      expect(res.expiresIn).toBe(300);
      expect(res.otpRef).toBe(`otp:request:trusted-person:${PARENT_USER}`);
      expect(h.sms.sent).toHaveLength(1);
      expect(h.sms.sent[0].phone).toBe(PHONE);
      expect(h.sms.sent[0].message).toContain('Shyraq');
      expect(h.otpStore.codes.get(PARENT_USER)?.code).toMatch(/^\d{6}$/);
    });

    it('throws OtpRateLimitedError when per-phone budget exceeded', async () => {
      const h = buildHarness();
      h.authOtpStore.rateLimitState = 'exceeded';
      await expect(
        h.service.sendOtpForTrustedPerson(KG, PARENT_USER, CHILD, PHONE),
      ).rejects.toBeInstanceOf(OtpRateLimitedError);
      expect(h.sms.sent).toHaveLength(0);
    });

    it('throws OtpLockedError when user is locked', async () => {
      const h = buildHarness();
      h.otpStore.locks.add(PARENT_USER);
      await expect(
        h.service.sendOtpForTrustedPerson(KG, PARENT_USER, CHILD, PHONE),
      ).rejects.toBeInstanceOf(OtpLockedError);
      expect(h.sms.sent).toHaveLength(0);
    });

    it('throws ParentRequestForbiddenError when caller is not an approved guardian', async () => {
      const h = buildHarness();
      await expect(
        h.service.sendOtpForTrustedPerson(KG, OTHER_PARENT_USER, CHILD, PHONE),
      ).rejects.toBeInstanceOf(ParentRequestForbiddenError);
    });

    it('throws CreateRequestPermissionRequiredError when nanny calls', async () => {
      const h = buildHarness();
      const nannyUser = 'aaaaaaaa-7777-7777-7777-aaaaaaaaaaaa';
      h.guardianRepo.put(makeApprovedGuardian(nannyUser, CHILD, {}, 'nanny'));
      await expect(
        h.service.sendOtpForTrustedPerson(KG, nannyUser, CHILD, PHONE),
      ).rejects.toBeInstanceOf(CreateRequestPermissionRequiredError);
    });

    it('allows nanny when primary explicitly grants create_requests=true override (H1 codex — TOGGLEABLE per docs)', async () => {
      // Permission model decision: `create_requests` is TOGGLEABLE (not locked
      // by role) per endpoints.md §4.13 + BP §11 line 997. Primary may grant
      // it to a nanny; the gate honours the override. This test pins the
      // documented behaviour so a future "lock for nanny" change must be a
      // deliberate doc + code change, not an accidental drift.
      const h = buildHarness();
      const nannyUser = 'aaaaaaaa-8888-8888-8888-aaaaaaaaaaaa';
      h.guardianRepo.put(
        makeApprovedGuardian(
          nannyUser,
          CHILD,
          { create_requests: true },
          'nanny',
        ),
      );
      await expect(
        h.service.sendOtpForTrustedPerson(KG, nannyUser, CHILD, PHONE),
      ).resolves.toMatchObject({ otpRef: expect.any(String) });
    });
  });

  describe('createTrustedPersonRequest', () => {
    it('creates pending request after consuming a valid code', async () => {
      const h = buildHarness();
      await h.otpStore.storeCode(PARENT_USER, '123456', 300);
      const pr = await h.service.createTrustedPersonRequest(KG, PARENT_USER, {
        code: '123456',
        childId: CHILD,
        fullName: 'Aigul',
        phone: '+77070001111',
        iin: null,
        relation: 'aunt',
        photoUrl: null,
        isOneTime: false,
        createPickupRequest: false,
        comment: null,
      });
      expect(pr.requestType).toBe('trusted_person');
      expect(pr.status).toBe('pending');
      expect(pr.recipientType).toBe('admin');
      expect(h.otpStore.codes.has(PARENT_USER)).toBe(false);
    });

    it('throws OtpInvalidError on wrong code', async () => {
      const h = buildHarness();
      await h.otpStore.storeCode(PARENT_USER, '123456', 300);
      await expect(
        h.service.createTrustedPersonRequest(KG, PARENT_USER, {
          code: '999999',
          childId: CHILD,
          fullName: 'Aigul',
          phone: PHONE,
          iin: null,
          relation: 'aunt',
          photoUrl: null,
          isOneTime: false,
          createPickupRequest: false,
          comment: null,
        }),
      ).rejects.toBeInstanceOf(OtpInvalidError);
      expect(h.otpStore.attempts.get(PARENT_USER)).toBe(1);
    });

    it('locks user after 3 wrong attempts and throws OtpLockedError', async () => {
      const h = buildHarness();
      await h.otpStore.storeCode(PARENT_USER, '123456', 300);
      const dto = {
        code: '999999',
        childId: CHILD,
        fullName: 'Aigul',
        phone: PHONE,
        iin: null,
        relation: 'aunt',
        photoUrl: null,
        isOneTime: false,
        createPickupRequest: false,
        comment: null,
      };
      await expect(
        h.service.createTrustedPersonRequest(KG, PARENT_USER, dto),
      ).rejects.toBeInstanceOf(OtpInvalidError);
      await expect(
        h.service.createTrustedPersonRequest(KG, PARENT_USER, dto),
      ).rejects.toBeInstanceOf(OtpInvalidError);
      await expect(
        h.service.createTrustedPersonRequest(KG, PARENT_USER, dto),
      ).rejects.toBeInstanceOf(OtpLockedError);
      expect(h.otpStore.locks.has(PARENT_USER)).toBe(true);
    });

    it('throws OtpExpiredError when code missing in store', async () => {
      const h = buildHarness();
      await expect(
        h.service.createTrustedPersonRequest(KG, PARENT_USER, {
          code: '123456',
          childId: CHILD,
          fullName: 'Aigul',
          phone: PHONE,
          iin: null,
          relation: 'aunt',
          photoUrl: null,
          isOneTime: false,
          createPickupRequest: false,
          comment: null,
        }),
      ).rejects.toBeInstanceOf(OtpExpiredError);
    });

    it('throws CreateRequestPermissionRequiredError for nanny role', async () => {
      const h = buildHarness();
      const nannyUser = 'aaaaaaaa-8888-8888-8888-aaaaaaaaaaaa';
      h.guardianRepo.put(makeApprovedGuardian(nannyUser, CHILD, {}, 'nanny'));
      await h.otpStore.storeCode(nannyUser, '123456', 300);
      await expect(
        h.service.createTrustedPersonRequest(KG, nannyUser, {
          code: '123456',
          childId: CHILD,
          fullName: 'Aigul',
          phone: PHONE,
          iin: null,
          relation: 'aunt',
          photoUrl: null,
          isOneTime: false,
          createPickupRequest: false,
          comment: null,
        }),
      ).rejects.toBeInstanceOf(CreateRequestPermissionRequiredError);
    });
  });

  describe('createDayOffRequest', () => {
    it('creates pending request with 1 weekend (Sat)', async () => {
      const h = buildHarness();
      // 2026-05-09 is a Saturday (NOW=2026-05-04 Mon)
      const pr = await h.service.createDayOffRequest(KG, PARENT_USER, {
        childId: CHILD,
        weekendDates: ['2026-05-09'],
        comment: null,
      });
      expect(pr.requestType).toBe('day_off');
      expect(pr.recipientType).toBe('mentor');
      expect(pr.recipientStaffId).toBe(STAFF_MENTOR_ID);
      expect(pr.details.weekend_dates).toEqual(['2026-05-09']);
    });

    it('creates request with Sat + Sun in the same week', async () => {
      const h = buildHarness();
      // Sat 2026-05-09, Sun 2026-05-10 — Mon-anchor matches
      const pr = await h.service.createDayOffRequest(KG, PARENT_USER, {
        childId: CHILD,
        weekendDates: ['2026-05-09', '2026-05-10'],
        comment: null,
      });
      expect(pr.requestType).toBe('day_off');
    });

    it('rejects a weekday', async () => {
      const h = buildHarness();
      await expect(
        h.service.createDayOffRequest(KG, PARENT_USER, {
          childId: CHILD,
          weekendDates: ['2026-05-04'], // Monday
          comment: null,
        }),
      ).rejects.toBeInstanceOf(InvariantViolationError);
    });

    it('rejects 2 dates in different weeks', async () => {
      const h = buildHarness();
      // Sat 2026-05-09 and next Sat 2026-05-16 — different weeks
      await expect(
        h.service.createDayOffRequest(KG, PARENT_USER, {
          childId: CHILD,
          weekendDates: ['2026-05-09', '2026-05-16'],
          comment: null,
        }),
      ).rejects.toBeInstanceOf(InvariantViolationError);
    });

    it('rejects past date', async () => {
      const h = buildHarness();
      // NOW=2026-05-04; 2026-05-02 (Sat) is in the past
      await expect(
        h.service.createDayOffRequest(KG, PARENT_USER, {
          childId: CHILD,
          weekendDates: ['2026-05-02'],
          comment: null,
        }),
      ).rejects.toBeInstanceOf(InvariantViolationError);
    });

    it('falls back to admin recipient when no group mentor', async () => {
      const h = buildHarness();
      h.groupRepo.activeMentors.clear();
      const pr = await h.service.createDayOffRequest(KG, PARENT_USER, {
        childId: CHILD,
        weekendDates: ['2026-05-09'],
        comment: null,
      });
      expect(pr.recipientType).toBe('admin');
      expect(pr.recipientStaffId).toBeNull();
    });

    it('detects weekend in Asia/Almaty calendar across UTC midnight (M1 codex)', async () => {
      // 2026-05-08T20:00:00Z = 2026-05-09T01:00 Asia/Almaty.
      // 2026-05-09 is Saturday in Almaty → must accept.
      // Under the prior `getUTCDay()` path "today" check would also need to
      // pass — at 20:00Z on Fri the weekend date (Sat) is still future.
      const h = buildHarness();
      h.clock.set(new Date('2026-05-08T20:00:00.000Z'));
      const pr = await h.service.createDayOffRequest(KG, PARENT_USER, {
        childId: CHILD,
        weekendDates: ['2026-05-09'],
        comment: null,
      });
      expect(pr.requestType).toBe('day_off');
    });
  });

  describe('createVacationRequest', () => {
    it('creates request with valid range', async () => {
      const h = buildHarness();
      const pr = await h.service.createVacationRequest(KG, PARENT_USER, {
        childId: CHILD,
        dateFrom: '2026-05-15',
        dateTo: '2026-05-20',
        comment: null,
      });
      expect(pr.requestType).toBe('vacation');
      expect(pr.dateFrom).not.toBeNull();
      expect(pr.dateTo).not.toBeNull();
    });

    it('rejects date_from > date_to', async () => {
      const h = buildHarness();
      await expect(
        h.service.createVacationRequest(KG, PARENT_USER, {
          childId: CHILD,
          dateFrom: '2026-05-20',
          dateTo: '2026-05-15',
          comment: null,
        }),
      ).rejects.toBeInstanceOf(InvariantViolationError);
    });

    it('rejects past date_from', async () => {
      const h = buildHarness();
      await expect(
        h.service.createVacationRequest(KG, PARENT_USER, {
          childId: CHILD,
          dateFrom: '2026-04-15',
          dateTo: '2026-05-15',
          comment: null,
        }),
      ).rejects.toBeInstanceOf(InvariantViolationError);
    });

    it('honours Asia/Almaty calendar at the UTC midnight boundary (M1 codex)', async () => {
      // 2026-05-06T20:00:00Z = 2026-05-07T01:00 Asia/Almaty (UTC+5).
      // Date "2026-05-07" is TODAY in Almaty (not past) — must validate.
      // Under the old UTC-midnight gate this was rejected as past.
      const h = buildHarness();
      h.clock.set(new Date('2026-05-06T20:00:00.000Z'));
      const pr = await h.service.createVacationRequest(KG, PARENT_USER, {
        childId: CHILD,
        dateFrom: '2026-05-07',
        dateTo: '2026-05-10',
        comment: null,
      });
      expect(pr.requestType).toBe('vacation');
    });
  });

  describe('createLatePickupRequest', () => {
    it('creates request with valid HH:MM and future date', async () => {
      const h = buildHarness();
      const pr = await h.service.createLatePickupRequest(KG, PARENT_USER, {
        childId: CHILD,
        date: '2026-05-15',
        expectedTime: '19:30',
        comment: null,
      });
      expect(pr.requestType).toBe('late_pickup');
      expect(pr.details.expected_time).toBe('19:30');
    });

    it('rejects invalid HH:MM', async () => {
      const h = buildHarness();
      await expect(
        h.service.createLatePickupRequest(KG, PARENT_USER, {
          childId: CHILD,
          date: '2026-05-15',
          expectedTime: '25:00',
          comment: null,
        }),
      ).rejects.toBeInstanceOf(InvariantViolationError);
    });

    it('rejects past date', async () => {
      const h = buildHarness();
      await expect(
        h.service.createLatePickupRequest(KG, PARENT_USER, {
          childId: CHILD,
          date: '2026-04-30',
          expectedTime: '19:30',
          comment: null,
        }),
      ).rejects.toBeInstanceOf(InvariantViolationError);
    });
  });

  describe('createOpenRequest', () => {
    it('creates specialist-routed request with explicit staff_id', async () => {
      const h = buildHarness();
      const pr = await h.service.createOpenRequest(KG, PARENT_USER, {
        childId: CHILD,
        recipientType: 'specialist',
        recipientStaffId: STAFF_SPECIALIST_ID,
        subject: 'q',
        message: 'hi',
        attachments: null,
      });
      expect(pr.recipientType).toBe('specialist');
      expect(pr.recipientStaffId).toBe(STAFF_SPECIALIST_ID);
    });

    it('rejects specialist without recipient_staff_id', async () => {
      const h = buildHarness();
      await expect(
        h.service.createOpenRequest(KG, PARENT_USER, {
          childId: CHILD,
          recipientType: 'specialist',
          recipientStaffId: null,
          subject: 'q',
          message: 'hi',
          attachments: null,
        }),
      ).rejects.toBeInstanceOf(InvariantViolationError);
    });

    it('rejects specialist with mentor staff_id (role mismatch)', async () => {
      const h = buildHarness();
      await expect(
        h.service.createOpenRequest(KG, PARENT_USER, {
          childId: CHILD,
          recipientType: 'specialist',
          recipientStaffId: STAFF_MENTOR_ID,
          subject: 'q',
          message: 'hi',
          attachments: null,
        }),
      ).rejects.toBeInstanceOf(InvariantViolationError);
    });

    it('mentor recipient resolves to child group mentor when staff_id omitted', async () => {
      const h = buildHarness();
      const pr = await h.service.createOpenRequest(KG, PARENT_USER, {
        childId: CHILD,
        recipientType: 'mentor',
        recipientStaffId: null,
        subject: 'q',
        message: 'hi',
        attachments: null,
      });
      expect(pr.recipientType).toBe('mentor');
      expect(pr.recipientStaffId).toBe(STAFF_MENTOR_ID);
    });

    it('admin recipient discards recipient_staff_id', async () => {
      const h = buildHarness();
      const pr = await h.service.createOpenRequest(KG, PARENT_USER, {
        childId: CHILD,
        recipientType: 'admin',
        recipientStaffId: STAFF_MENTOR_ID, // ignored
        subject: 'q',
        message: 'hi',
        attachments: null,
      });
      expect(pr.recipientType).toBe('admin');
      expect(pr.recipientStaffId).toBeNull();
    });
  });

  describe('cancelRequest', () => {
    it('cancels a pending request owned by caller', async () => {
      const h = buildHarness();
      const pr = await h.service.createDayOffRequest(KG, PARENT_USER, {
        childId: CHILD,
        weekendDates: ['2026-05-09'],
        comment: null,
      });
      const cancelled = await h.service.cancelRequest(KG, PARENT_USER, pr.id);
      expect(cancelled.status).toBe('cancelled');
      expect(h.notify.cancelledEvents).toHaveLength(1);
    });

    it('throws ParentRequestNotFoundError on non-existent', async () => {
      const h = buildHarness();
      await expect(
        h.service.cancelRequest(KG, PARENT_USER, 'no-such-id'),
      ).rejects.toBeInstanceOf(ParentRequestNotFoundError);
    });

    it('throws ParentRequestForbiddenError when caller is not requester', async () => {
      const h = buildHarness();
      const pr = await h.service.createDayOffRequest(KG, PARENT_USER, {
        childId: CHILD,
        weekendDates: ['2026-05-09'],
        comment: null,
      });
      await expect(
        h.service.cancelRequest(KG, OTHER_PARENT_USER, pr.id),
      ).rejects.toBeInstanceOf(ParentRequestForbiddenError);
    });

    it('throws ParentRequestAlreadyProcessedError when already accepted', async () => {
      const h = buildHarness();
      const pr = await h.service.createDayOffRequest(KG, PARENT_USER, {
        childId: CHILD,
        weekendDates: ['2026-05-09'],
        comment: null,
      });
      await h.service.acceptRequest(
        KG,
        {
          staffMemberId: STAFF_MENTOR_ID,
          userId: STAFF_USER,
          role: 'mentor',
        },
        pr.id,
        null,
      );
      await expect(
        h.service.cancelRequest(KG, PARENT_USER, pr.id),
      ).rejects.toBeInstanceOf(ParentRequestAlreadyProcessedError);
    });

    it('returns 404 across tenant boundary (kgId mismatch)', async () => {
      const h = buildHarness();
      const pr = await h.service.createDayOffRequest(KG, PARENT_USER, {
        childId: CHILD,
        weekendDates: ['2026-05-09'],
        comment: null,
      });
      await expect(
        h.service.cancelRequest(KG_OTHER, PARENT_USER, pr.id),
      ).rejects.toBeInstanceOf(ParentRequestNotFoundError);
    });
  });

  describe('acceptRequest', () => {
    it('accepts pending request and emits request.accepted', async () => {
      const h = buildHarness();
      const pr = await h.service.createDayOffRequest(KG, PARENT_USER, {
        childId: CHILD,
        weekendDates: ['2026-05-09'],
        comment: null,
      });
      const accepted = await h.service.acceptRequest(
        KG,
        {
          staffMemberId: STAFF_MENTOR_ID,
          userId: STAFF_USER,
          role: 'mentor',
        },
        pr.id,
        'ok',
      );
      expect(accepted.status).toBe('accepted');
      expect(accepted.reviewedBy).toBe(STAFF_MENTOR_ID);
      expect(accepted.reviewNote).toBe('ok');
      expect(h.notify.acceptedEvents).toHaveLength(1);
    });

    it('throws 409 when already processed', async () => {
      const h = buildHarness();
      const pr = await h.service.createDayOffRequest(KG, PARENT_USER, {
        childId: CHILD,
        weekendDates: ['2026-05-09'],
        comment: null,
      });
      const caller = {
        staffMemberId: STAFF_MENTOR_ID,
        userId: STAFF_USER,
        role: 'mentor' as const,
      };
      await h.service.acceptRequest(KG, caller, pr.id, null);
      await expect(
        h.service.acceptRequest(KG, caller, pr.id, null),
      ).rejects.toBeInstanceOf(ParentRequestAlreadyProcessedError);
    });

    it('returns 404 when not found in tenant', async () => {
      const h = buildHarness();
      await expect(
        h.service.acceptRequest(
          KG,
          {
            staffMemberId: STAFF_MENTOR_ID,
            userId: STAFF_USER,
            role: 'mentor',
          },
          'no-such',
          null,
        ),
      ).rejects.toBeInstanceOf(ParentRequestNotFoundError);
    });

    it('forbids specialist from accepting mentor-routed request', async () => {
      const h = buildHarness();
      const pr = await h.service.createDayOffRequest(KG, PARENT_USER, {
        childId: CHILD,
        weekendDates: ['2026-05-09'],
        comment: null,
      });
      await expect(
        h.service.acceptRequest(
          KG,
          {
            staffMemberId: STAFF_SPECIALIST_ID,
            userId: STAFF_USER_OTHER,
            role: 'specialist',
          },
          pr.id,
          null,
        ),
      ).rejects.toBeInstanceOf(ParentRequestForbiddenError);
    });

    it('admin can accept anything in kg', async () => {
      const h = buildHarness();
      const pr = await h.service.createDayOffRequest(KG, PARENT_USER, {
        childId: CHILD,
        weekendDates: ['2026-05-09'],
        comment: null,
      });
      const accepted = await h.service.acceptRequest(
        KG,
        {
          staffMemberId: STAFF_ADMIN_ID,
          userId: 'aaaaaaaa-6666-6666-6666-aaaaaaaaaaaa',
          role: 'admin',
        },
        pr.id,
        null,
      );
      expect(accepted.status).toBe('accepted');
    });

    it('forbids mentor from accepting another mentor-routed request', async () => {
      const h = buildHarness();
      // Create a request directed at OTHER mentor
      const pr = await h.service.createOpenRequest(KG, PARENT_USER, {
        childId: CHILD,
        recipientType: 'mentor',
        recipientStaffId: STAFF_OTHER_MENTOR_ID,
        subject: 'q',
        message: 'hi',
        attachments: null,
      });
      await expect(
        h.service.acceptRequest(
          KG,
          {
            staffMemberId: STAFF_MENTOR_ID,
            userId: STAFF_USER,
            role: 'mentor',
          },
          pr.id,
          null,
        ),
      ).rejects.toBeInstanceOf(ParentRequestForbiddenError);
    });

    it('on accept(trusted_person) creates trusted_people row', async () => {
      const h = buildHarness();
      await h.otpStore.storeCode(PARENT_USER, '123456', 300);
      const pr = await h.service.createTrustedPersonRequest(KG, PARENT_USER, {
        code: '123456',
        childId: CHILD,
        fullName: 'Aigul',
        phone: '+77079999999',
        iin: null,
        relation: 'aunt',
        photoUrl: null,
        isOneTime: false,
        createPickupRequest: false,
        comment: null,
      });
      await h.service.acceptRequest(
        KG,
        {
          staffMemberId: STAFF_ADMIN_ID,
          userId: 'aaaaaaaa-6666-6666-6666-aaaaaaaaaaaa',
          role: 'admin',
        },
        pr.id,
        null,
      );
      expect(h.tpRepo.createCalls).toHaveLength(1);
      expect(h.tpRepo.createCalls[0].fullName).toBe('Aigul');
      expect(h.pickupRepo.createCalls).toHaveLength(0);
    });

    it('on accept(trusted_person, create_pickup_request=true) also creates pickup_request linked', async () => {
      const h = buildHarness();
      await h.otpStore.storeCode(PARENT_USER, '123456', 300);
      const pr = await h.service.createTrustedPersonRequest(KG, PARENT_USER, {
        code: '123456',
        childId: CHILD,
        fullName: 'Aigul',
        phone: '+77079999999',
        iin: null,
        relation: 'aunt',
        photoUrl: null,
        isOneTime: false,
        createPickupRequest: true,
        comment: null,
      });
      await h.service.acceptRequest(
        KG,
        {
          staffMemberId: STAFF_ADMIN_ID,
          userId: 'aaaaaaaa-6666-6666-6666-aaaaaaaaaaaa',
          role: 'admin',
        },
        pr.id,
        null,
      );
      expect(h.tpRepo.createCalls).toHaveLength(1);
      expect(h.pickupRepo.createCalls).toHaveLength(1);
      expect(h.pickupRepo.createCalls[0].parentRequestId).toBe(pr.id);
      expect(h.pickupRepo.createCalls[0].trustedPersonId).toBe(
        h.tpRepo.rows[0].id,
      );
    });

    it('on accept(late_pickup) generates a late_pickup invoice and links it to the parent_request (B13 hook)', async () => {
      const h = buildHarness();
      const pr = await h.service.createLatePickupRequest(KG, PARENT_USER, {
        childId: CHILD,
        date: '2026-05-15',
        expectedTime: '19:30',
        comment: null,
      });
      const accepted = await h.service.acceptRequest(
        KG,
        {
          staffMemberId: STAFF_MENTOR_ID,
          userId: STAFF_USER,
          role: 'mentor',
        },
        pr.id,
        null,
      );
      expect(accepted.status).toBe('accepted');
      expect(accepted.invoiceId).toBe(`fake-invoice-id-${pr.id}`);

      expect(h.invoiceService.generateLatePickupInvoiceCalls).toHaveLength(1);
      const call = h.invoiceService.generateLatePickupInvoiceCalls[0];
      expect(call.kindergartenId).toBe(KG);
      expect(call.childId).toBe(CHILD);
      expect(call.parentRequestId).toBe(pr.id);
      expect(call.expectedTime).toBe('19:30');
      expect(call.actualTime).toBe('19:30');
      expect(call.requestedBy).toBe(PARENT_USER);
      expect(call.date.toISOString().slice(0, 10)).toBe('2026-05-15');

      expect(h.parentRequestRepo.setInvoiceIdCalls).toHaveLength(1);
      expect(h.parentRequestRepo.setInvoiceIdCalls[0]).toEqual({
        kg: KG,
        parentRequestId: pr.id,
        invoiceId: `fake-invoice-id-${pr.id}`,
      });

      // Persisted state should also reflect the linked invoice id.
      const reloaded = h.parentRequestRepo.rows.get(pr.id);
      expect(reloaded?.invoiceId).toBe(`fake-invoice-id-${pr.id}`);

      expect(h.notify.acceptedEvents).toHaveLength(1);
    });

    it('rolls back accept(late_pickup) when invoice generation fails (no tariff)', async () => {
      const h = buildHarness();
      const pr = await h.service.createLatePickupRequest(KG, PARENT_USER, {
        childId: CHILD,
        date: '2026-05-15',
        expectedTime: '19:30',
        comment: null,
      });
      h.invoiceService.errorToThrow = new TariffPlanNotFoundError(
        'late_pickup_fee',
      );
      await expect(
        h.service.acceptRequest(
          KG,
          {
            staffMemberId: STAFF_MENTOR_ID,
            userId: STAFF_USER,
            role: 'mentor',
          },
          pr.id,
          null,
        ),
      ).rejects.toBeInstanceOf(TariffPlanNotFoundError);

      // setInvoiceId never reached.
      expect(h.parentRequestRepo.setInvoiceIdCalls).toHaveLength(0);
      // acceptedEvent never dispatched.
      expect(h.notify.acceptedEvents).toHaveLength(0);
      // Note: in the in-memory fake the conditional UPDATE runs BEFORE the
      // invoice call (matching real flow). In production, the ambient TX
      // rollback unwinds that UPDATE; the fake does not simulate TX rollback
      // — what matters is that the invoice failure path propagates and the
      // downstream side-effects (notification + linkage) never run.
    });

    it('on accept(day_off) does NOT call the invoice service (only late_pickup triggers the B13 hook)', async () => {
      const h = buildHarness();
      const pr = await h.service.createDayOffRequest(KG, PARENT_USER, {
        childId: CHILD,
        weekendDates: ['2026-05-09'],
        comment: null,
      });
      await h.service.acceptRequest(
        KG,
        {
          staffMemberId: STAFF_MENTOR_ID,
          userId: STAFF_USER,
          role: 'mentor',
        },
        pr.id,
        null,
      );
      expect(h.invoiceService.generateLatePickupInvoiceCalls).toHaveLength(0);
      expect(h.parentRequestRepo.setInvoiceIdCalls).toHaveLength(0);
    });

    it('on accept(trusted_person) does NOT call the invoice service', async () => {
      const h = buildHarness();
      await h.otpStore.storeCode(PARENT_USER, '123456', 300);
      const pr = await h.service.createTrustedPersonRequest(KG, PARENT_USER, {
        code: '123456',
        childId: CHILD,
        fullName: 'Aigul',
        phone: '+77079999999',
        iin: null,
        relation: 'aunt',
        photoUrl: null,
        isOneTime: false,
        createPickupRequest: false,
        comment: null,
      });
      await h.service.acceptRequest(
        KG,
        {
          staffMemberId: STAFF_ADMIN_ID,
          userId: 'aaaaaaaa-6666-6666-6666-aaaaaaaaaaaa',
          role: 'admin',
        },
        pr.id,
        null,
      );
      expect(h.invoiceService.generateLatePickupInvoiceCalls).toHaveLength(0);
    });
  });

  describe('rejectRequest', () => {
    it('flips status to rejected and emits event', async () => {
      const h = buildHarness();
      const pr = await h.service.createDayOffRequest(KG, PARENT_USER, {
        childId: CHILD,
        weekendDates: ['2026-05-09'],
        comment: null,
      });
      const rejected = await h.service.rejectRequest(
        KG,
        {
          staffMemberId: STAFF_MENTOR_ID,
          userId: STAFF_USER,
          role: 'mentor',
        },
        pr.id,
        'busy',
      );
      expect(rejected.status).toBe('rejected');
      expect(rejected.reviewNote).toBe('busy');
      expect(h.notify.rejectedEvents).toHaveLength(1);
    });

    it('throws 409 when already accepted', async () => {
      const h = buildHarness();
      const pr = await h.service.createDayOffRequest(KG, PARENT_USER, {
        childId: CHILD,
        weekendDates: ['2026-05-09'],
        comment: null,
      });
      const caller = {
        staffMemberId: STAFF_MENTOR_ID,
        userId: STAFF_USER,
        role: 'mentor' as const,
      };
      await h.service.acceptRequest(KG, caller, pr.id, null);
      await expect(
        h.service.rejectRequest(KG, caller, pr.id, null),
      ).rejects.toBeInstanceOf(ParentRequestAlreadyProcessedError);
    });
  });

  describe('thread (messages)', () => {
    it('parent author writes message and emits message_sent', async () => {
      const h = buildHarness();
      const pr = await h.service.createDayOffRequest(KG, PARENT_USER, {
        childId: CHILD,
        weekendDates: ['2026-05-09'],
        comment: null,
      });
      const m = await h.service.addParentMessage(KG, PARENT_USER, pr.id, {
        body: 'thanks',
        attachments: null,
      });
      expect(m.authorUserId).toBe(PARENT_USER);
      expect(m.authorStaffId).toBeNull();
      expect(h.notify.messageSentEvents).toHaveLength(1);
      expect(h.notify.messageSentEvents[0].authorRole).toBe('parent');
    });

    it('staff author writes message with author_staff_id (XOR enforced)', async () => {
      const h = buildHarness();
      const pr = await h.service.createDayOffRequest(KG, PARENT_USER, {
        childId: CHILD,
        weekendDates: ['2026-05-09'],
        comment: null,
      });
      const m = await h.service.addStaffMessage(
        KG,
        {
          staffMemberId: STAFF_MENTOR_ID,
          userId: STAFF_USER,
          role: 'mentor',
        },
        pr.id,
        { body: 'ok', attachments: null },
      );
      expect(m.authorUserId).toBeNull();
      expect(m.authorStaffId).toBe(STAFF_MENTOR_ID);
      expect(h.notify.messageSentEvents).toHaveLength(1);
      expect(h.notify.messageSentEvents[0].authorRole).toBe('staff');
    });

    it('parent posting on a request they do not own → 403', async () => {
      const h = buildHarness();
      const pr = await h.service.createDayOffRequest(KG, PARENT_USER, {
        childId: CHILD,
        weekendDates: ['2026-05-09'],
        comment: null,
      });
      await expect(
        h.service.addParentMessage(KG, OTHER_PARENT_USER, pr.id, {
          body: 'hi',
          attachments: null,
        }),
      ).rejects.toBeInstanceOf(ParentRequestForbiddenError);
    });

    it('listMessagesForParent rejects non-requester', async () => {
      const h = buildHarness();
      const pr = await h.service.createDayOffRequest(KG, PARENT_USER, {
        childId: CHILD,
        weekendDates: ['2026-05-09'],
        comment: null,
      });
      await expect(
        h.service.listMessagesForParent(KG, OTHER_PARENT_USER, pr.id, 50, null),
      ).rejects.toBeInstanceOf(ParentRequestForbiddenError);
    });

    it('listMessagesForStaff rejects unrelated mentor', async () => {
      const h = buildHarness();
      const pr = await h.service.createOpenRequest(KG, PARENT_USER, {
        childId: CHILD,
        recipientType: 'mentor',
        recipientStaffId: STAFF_OTHER_MENTOR_ID,
        subject: 'q',
        message: 'hi',
        attachments: null,
      });
      await expect(
        h.service.listMessagesForStaff(
          KG,
          {
            staffMemberId: STAFF_MENTOR_ID,
            userId: STAFF_USER,
            role: 'mentor',
          },
          pr.id,
          50,
          null,
        ),
      ).rejects.toBeInstanceOf(ParentRequestForbiddenError);
    });
  });

  describe('lists', () => {
    it("listForParent filters to caller's own requests", async () => {
      const h = buildHarness();
      // Two parents create requests
      h.guardianRepo.put(
        makeApprovedGuardian(OTHER_PARENT_USER, CHILD_OTHER, {}),
      );
      h.childRepo.put(makeChild({ id: CHILD_OTHER, groupId: null }));
      await h.service.createDayOffRequest(KG, PARENT_USER, {
        childId: CHILD,
        weekendDates: ['2026-05-09'],
        comment: null,
      });
      await h.service.createOpenRequest(KG, OTHER_PARENT_USER, {
        childId: CHILD_OTHER,
        recipientType: 'admin',
        recipientStaffId: null,
        subject: 's',
        message: 'm',
        attachments: null,
      });
      const result = await h.service.listForParent(KG, PARENT_USER, {});
      expect(result.items).toHaveLength(1);
      expect(result.items[0].requesterUserId).toBe(PARENT_USER);
    });

    it('listForStaffInbox: admin sees all, mentor sees own queue', async () => {
      const h = buildHarness();
      // Mentor request → STAFF_MENTOR_ID; admin request → null
      await h.service.createDayOffRequest(KG, PARENT_USER, {
        childId: CHILD,
        weekendDates: ['2026-05-09'],
        comment: null,
      });
      await h.service.createOpenRequest(KG, PARENT_USER, {
        childId: CHILD,
        recipientType: 'admin',
        recipientStaffId: null,
        subject: 's',
        message: 'm',
        attachments: null,
      });

      const adminInbox = await h.service.listForStaffInbox(
        KG,
        {
          staffMemberId: STAFF_ADMIN_ID,
          userId: 'admin',
          role: 'admin',
        },
        {},
      );
      expect(adminInbox.items).toHaveLength(2);

      const mentorInbox = await h.service.listForStaffInbox(
        KG,
        {
          staffMemberId: STAFF_MENTOR_ID,
          userId: STAFF_USER,
          role: 'mentor',
        },
        {},
      );
      expect(mentorInbox.items).toHaveLength(1);
      expect(mentorInbox.items[0].recipientStaffId).toBe(STAFF_MENTOR_ID);
    });

    it('listAllForAdmin filters by recipient_type', async () => {
      const h = buildHarness();
      await h.service.createDayOffRequest(KG, PARENT_USER, {
        childId: CHILD,
        weekendDates: ['2026-05-09'],
        comment: null,
      });
      await h.service.createOpenRequest(KG, PARENT_USER, {
        childId: CHILD,
        recipientType: 'admin',
        recipientStaffId: null,
        subject: 's',
        message: 'm',
        attachments: null,
      });
      const adminOnly = await h.service.listAllForAdmin(KG, {
        recipientType: 'admin',
      });
      expect(adminOnly.items).toHaveLength(1);
      expect(adminOnly.items[0].recipientType).toBe('admin');
    });

    it('listForStaffInbox filters by groupId — only requests whose child belongs to the group (M2 codex)', async () => {
      const h = buildHarness();
      const OTHER_GROUP = 'gggggggg-9999-8888-7777-gggggggggggg';
      // Second child in a different group, with the same primary parent.
      h.childRepo.put(makeChild({ id: CHILD_OTHER, groupId: OTHER_GROUP }));
      h.guardianRepo.put(makeApprovedGuardian(PARENT_USER, CHILD_OTHER));
      h.groupRepo.putMentor(OTHER_GROUP, makeMentor(STAFF_OTHER_MENTOR_ID));

      // 1 request per child — different groups.
      await h.service.createDayOffRequest(KG, PARENT_USER, {
        childId: CHILD,
        weekendDates: ['2026-05-09'],
        comment: null,
      });
      await h.service.createDayOffRequest(KG, PARENT_USER, {
        childId: CHILD_OTHER,
        weekendDates: ['2026-05-09'],
        comment: null,
      });

      const filtered = await h.service.listForStaffInbox(
        KG,
        {
          staffMemberId: STAFF_ADMIN_ID,
          userId: 'admin',
          role: 'admin',
        },
        { groupId: GROUP_ID },
      );
      expect(filtered.items).toHaveLength(1);
      expect(filtered.items[0].childId).toBe(CHILD);
    });

    it('listAllForAdmin filters by groupId (M2 codex)', async () => {
      const h = buildHarness();
      const OTHER_GROUP = 'gggggggg-9999-8888-7777-gggggggggggg';
      h.childRepo.put(makeChild({ id: CHILD_OTHER, groupId: OTHER_GROUP }));
      h.guardianRepo.put(makeApprovedGuardian(PARENT_USER, CHILD_OTHER));
      h.groupRepo.putMentor(OTHER_GROUP, makeMentor(STAFF_OTHER_MENTOR_ID));

      await h.service.createDayOffRequest(KG, PARENT_USER, {
        childId: CHILD,
        weekendDates: ['2026-05-09'],
        comment: null,
      });
      await h.service.createDayOffRequest(KG, PARENT_USER, {
        childId: CHILD_OTHER,
        weekendDates: ['2026-05-09'],
        comment: null,
      });

      const filtered = await h.service.listAllForAdmin(KG, {
        groupId: OTHER_GROUP,
      });
      expect(filtered.items).toHaveLength(1);
      expect(filtered.items[0].childId).toBe(CHILD_OTHER);
    });

    // ── B22b T7 M16 cursor pagination ──────────────────────────────────
    describe('cursor pagination', () => {
      it('emits a non-null next_cursor when more than limit rows exist (M16 close)', async () => {
        const h = buildHarness();
        for (let i = 0; i < 3; i++) {
          await h.service.createDayOffRequest(KG, PARENT_USER, {
            childId: CHILD,
            weekendDates: ['2026-05-09'],
            comment: null,
          });
        }
        const first = await h.service.listForParent(KG, PARENT_USER, {
          limit: 2,
        });
        expect(first.items).toHaveLength(2);
        // M16 closure — pre-T7 this was unconditionally null.
        expect(first.nextCursor).not.toBeNull();
        expect(typeof first.nextCursor).toBe('string');
      });

      it('the next page (cursor round-trip) returns the remaining rows', async () => {
        const h = buildHarness();
        for (let i = 0; i < 3; i++) {
          await h.service.createDayOffRequest(KG, PARENT_USER, {
            childId: CHILD,
            weekendDates: ['2026-05-09'],
            comment: null,
          });
        }
        const first = await h.service.listForParent(KG, PARENT_USER, {
          limit: 2,
        });
        const second = await h.service.listForParent(KG, PARENT_USER, {
          limit: 2,
          cursor: first.nextCursor,
        });
        expect(second.items).toHaveLength(1);
        // No overlap between pages.
        const firstIds = first.items.map((p) => p.id);
        const secondIds = second.items.map((p) => p.id);
        for (const id of secondIds) {
          expect(firstIds).not.toContain(id);
        }
        // Final page → null cursor.
        expect(second.nextCursor).toBeNull();
      });

      it('emits null when the result fits in one page', async () => {
        const h = buildHarness();
        await h.service.createDayOffRequest(KG, PARENT_USER, {
          childId: CHILD,
          weekendDates: ['2026-05-09'],
          comment: null,
        });
        const result = await h.service.listForParent(KG, PARENT_USER, {
          limit: 50,
        });
        expect(result.items).toHaveLength(1);
        expect(result.nextCursor).toBeNull();
      });

      it('rejects a malformed cursor with InvariantViolationError (400)', async () => {
        const h = buildHarness();
        await expect(
          h.service.listForParent(KG, PARENT_USER, {
            cursor: '!!!not-base64-json!!!',
          }),
        ).rejects.toBeInstanceOf(InvariantViolationError);
      });

      it('disambiguates rows that share an identical createdAt via id tie-break', async () => {
        // FakeParentRequestRepo stamps every row with `new Date(NOW.getTime())`,
        // so all created rows have an identical createdAt millisecond — the
        // exact case where a single-key cursor would drop or duplicate rows.
        const h = buildHarness();
        for (let i = 0; i < 4; i++) {
          await h.service.createDayOffRequest(KG, PARENT_USER, {
            childId: CHILD,
            weekendDates: ['2026-05-09'],
            comment: null,
          });
        }
        const page1 = await h.service.listForParent(KG, PARENT_USER, {
          limit: 2,
        });
        const page2 = await h.service.listForParent(KG, PARENT_USER, {
          limit: 2,
          cursor: page1.nextCursor,
        });
        expect(page1.items).toHaveLength(2);
        expect(page2.items).toHaveLength(2);
        const allIds = new Set([
          ...page1.items.map((p) => p.id),
          ...page2.items.map((p) => p.id),
        ]);
        // 4 distinct ids across two pages (no duplicates, no drops).
        expect(allIds.size).toBe(4);
      });
    });
  });

  describe('getById', () => {
    it('getByIdForParent returns own request', async () => {
      const h = buildHarness();
      const pr = await h.service.createDayOffRequest(KG, PARENT_USER, {
        childId: CHILD,
        weekendDates: ['2026-05-09'],
        comment: null,
      });
      const fetched = await h.service.getByIdForParent(KG, PARENT_USER, pr.id);
      expect(fetched.id).toBe(pr.id);
    });

    it('getByIdForParent rejects non-requester (403)', async () => {
      const h = buildHarness();
      const pr = await h.service.createDayOffRequest(KG, PARENT_USER, {
        childId: CHILD,
        weekendDates: ['2026-05-09'],
        comment: null,
      });
      await expect(
        h.service.getByIdForParent(KG, OTHER_PARENT_USER, pr.id),
      ).rejects.toBeInstanceOf(ParentRequestForbiddenError);
    });

    it('getByIdForStaff rejects unrelated mentor', async () => {
      const h = buildHarness();
      const pr = await h.service.createOpenRequest(KG, PARENT_USER, {
        childId: CHILD,
        recipientType: 'mentor',
        recipientStaffId: STAFF_OTHER_MENTOR_ID,
        subject: 's',
        message: 'm',
        attachments: null,
      });
      await expect(
        h.service.getByIdForStaff(
          KG,
          {
            staffMemberId: STAFF_MENTOR_ID,
            userId: STAFF_USER,
            role: 'mentor',
          },
          pr.id,
        ),
      ).rejects.toBeInstanceOf(ParentRequestForbiddenError);
    });
  });

  describe('rate-limit', () => {
    it('per-user create rate-limit exceeded → throws OtpRateLimitedError', async () => {
      const h = buildHarness();
      h.authOtpStore.rateLimitGenericState = 'exceeded';
      await expect(
        h.service.createDayOffRequest(KG, PARENT_USER, {
          childId: CHILD,
          weekendDates: ['2026-05-09'],
          comment: null,
        }),
      ).rejects.toBeInstanceOf(OtpRateLimitedError);
      // Key is parent-create-namespaced (NOT auth's per-phone window).
      expect(h.authOtpStore.rateLimitGenericCalls[0]).toBe(
        `rate:parent_requests:create:${PARENT_USER}`,
      );
    });
  });
});
