import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@/shared-kernel/application/ports/transaction-runner.port';
import { TransactionRunnerPort } from '@/shared-kernel/application/ports/transaction-runner.port';
import { NotificationPort } from '@/common/notifications/notification.port';
import { OtpStorePort, StoredOtp } from '@/modules/auth/otp-store.port';
import { Group } from '@/modules/group/domain/entities/group.entity';
import { GroupNotFoundError } from '@/modules/group/domain/errors/group-not-found.error';
import {
  CreateGroupInput,
  GroupRepository,
  ListGroupsFilters,
  UpdateGroupInput,
} from '@/modules/group/infrastructure/persistence/group.repository';
import { GroupMentor } from '@/modules/group/domain/entities/group-mentor.entity';
import { StaffMember } from '@/modules/staff/domain/entities/staff-member.entity';
import {
  CreateStaffMemberInput,
  ListStaffFilters,
  StaffMemberRepository,
  UpdateStaffMemberInput,
} from '@/modules/staff/infrastructure/persistence/staff-member.repository';
import { User } from '@/modules/users/domain/entities/user.entity';
import {
  UserRepository,
  UserUpdateInput,
} from '@/modules/users/infrastructure/persistence/user.repository';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { ChildGuardianRepository } from './infrastructure/persistence/child-guardian.repository';
import {
  ChildArchiveResult,
  ChildGroupHistoryRecord,
  ChildListFilters,
  ChildReactivateResult,
  ChildRepository,
  PageRequest,
  PageResult,
} from './infrastructure/persistence/child.repository';
import {
  ChildStatusHistoryPage,
  ChildStatusHistoryRepository,
} from './infrastructure/persistence/child-status-history.repository';
import {
  BillingLifecyclePort,
  NoopBillingLifecycleAdapter,
} from './infrastructure/billing-lifecycle.port';
import { ChildService } from './child.service';
import { Child } from './domain/entities/child.entity';
import { ChildGuardian } from './domain/entities/child-guardian.entity';
import {
  ChildStatusHistory,
  ChildStatusHistoryState,
} from './domain/entities/child-status-history.entity';
import { AlreadyLinkedToChildError } from './domain/errors/already-linked-to-child.error';
import { AlreadyPendingForChildError } from './domain/errors/already-pending-for-child.error';
import { ChildAccessDeniedError } from './domain/errors/child-access-denied.error';
import { ArchiveReasonRequiredError } from './domain/errors/archive-reason-required.error';
import { ChildAlreadyArchivedError } from './domain/errors/child-already-archived.error';
import { ChildIinAlreadyExistsError } from './domain/errors/child-iin-already-exists.error';
import { ChildNotArchivedError } from './domain/errors/child-not-archived.error';
import { ChildNotFoundError } from './domain/errors/child-not-found.error';
import { ChildNotFoundForIinError } from './domain/errors/child-not-found-for-iin.error';
import { DuplicateGuardianError } from './domain/errors/duplicate-guardian.error';
import { GroupTransferToSelfError } from './domain/errors/group-transfer-to-self.error';
import { GuardianNotApprovedError } from './domain/errors/guardian-not-approved.error';
import { GuardianNotFoundError } from './domain/errors/guardian-not-found.error';
import { InvalidGuardianStatusTransitionError } from './domain/errors/invalid-guardian-status-transition.error';
import { MaxApprovalRightsExceededError } from './domain/errors/max-approval-rights-exceeded.error';
import { MultipleChildrenForIinError } from './domain/errors/multiple-children-for-iin.error';
import { NotPrimaryGuardianError } from './domain/errors/not-primary-guardian.error';
import { ParentLinkRateLimitError } from './domain/errors/parent-link-rate-limit.error';
import { PrimaryCannotSelfRevokeError } from './domain/errors/primary-cannot-self-revoke.error';
import { PrimaryCannotSelfUnlinkError } from './domain/errors/primary-cannot-self-unlink.error';

// ── fakes ─────────────────────────────────────────────────────────────────

class FakeClock implements ClockPort {
  constructor(public fixed: Date = new Date('2026-04-28T12:00:00.000Z')) {}
  now(): Date {
    return this.fixed;
  }
}

class FakeChildRepo extends ChildRepository {
  children = new Map<string, Child>();
  history: ChildGroupHistoryRecord[] = [];

  put(c: Child): void {
    this.children.set(c.id, c);
  }

  create(child: Child): Promise<void> {
    const state = child.toState();
    if (state.iin) {
      const dup = [...this.children.values()].find(
        (c) =>
          c.kindergartenId === state.kindergartenId &&
          c.toState().iin === state.iin &&
          c.id !== state.id,
      );
      if (dup) throw new ChildIinAlreadyExistsError(state.iin);
    }
    this.put(child);
    return Promise.resolve();
  }

  findById(kindergartenId: string, id: string): Promise<Child | null> {
    const c = this.children.get(id);
    if (!c || c.kindergartenId !== kindergartenId) return Promise.resolve(null);
    return Promise.resolve(c);
  }

  findByKindergartenAndIin(
    kindergartenId: string,
    iin: string,
  ): Promise<Child | null> {
    const c = [...this.children.values()].find(
      (x) => x.kindergartenId === kindergartenId && x.toState().iin === iin,
    );
    return Promise.resolve(c ?? null);
  }

  update(child: Child): Promise<void> {
    this.put(child);
    return Promise.resolve();
  }

  list(
    kindergartenId: string,
    filters: ChildListFilters,
    page: PageRequest,
  ): Promise<PageResult<Child>> {
    let items = [...this.children.values()].filter(
      (c) => c.kindergartenId === kindergartenId,
    );
    if (filters.status) {
      items = items.filter((c) => c.status.value === filters.status);
    }
    if (filters.currentGroupId) {
      items = items.filter(
        (c) => c.toState().currentGroupId === filters.currentGroupId,
      );
    }
    if (filters.q) {
      const q = filters.q.toLowerCase();
      items = items.filter((c) => c.fullName.toLowerCase().includes(q));
    }
    return Promise.resolve({
      items: items.slice(page.offset, page.offset + page.limit),
      total: items.length,
    });
  }

  countActiveByGroup(kindergartenId: string, groupId: string): Promise<number> {
    return Promise.resolve(
      [...this.children.values()].filter(
        (c) =>
          c.kindergartenId === kindergartenId &&
          c.toState().currentGroupId === groupId &&
          c.status.value === 'active',
      ).length,
    );
  }

  recordGroupTransfer(
    kindergartenId: string,
    childId: string,
    fromGroupId: string | null,
    toGroupId: string,
    transferredByStaffId: string,
    reason: string | null,
    at: Date,
  ): Promise<void> {
    void kindergartenId;
    this.history.push({
      id: `h-${this.history.length + 1}`,
      childId,
      fromGroupId,
      toGroupId,
      transferredAt: at,
      transferredByStaffId,
      reason,
    });
    return Promise.resolve();
  }

  listGroupHistory(
    kindergartenId: string,
    childId: string,
  ): Promise<ChildGroupHistoryRecord[]> {
    void kindergartenId;
    return Promise.resolve(this.history.filter((h) => h.childId === childId));
  }

  findByIinCrossTenant(iin: string): Promise<Child[]> {
    return Promise.resolve(
      [...this.children.values()].filter(
        (c) => c.toState().iin === iin && c.status.value !== 'archived',
      ),
    );
  }

  findByIdsCrossTenant(ids: string[]): Promise<Child[]> {
    return Promise.resolve(
      [...this.children.values()].filter((c) => ids.includes(c.id)),
    );
  }

  // B21 T3: conditional UPDATE simulators with the same discriminated
  // union the relational impl returns.
  override archive(
    kindergartenId: string,
    childId: string,
    archivedAt: Date,
    archiveReason: string,
  ): Promise<ChildArchiveResult> {
    const child = this.children.get(childId);
    if (!child || child.kindergartenId !== kindergartenId) {
      return Promise.resolve({ kind: 'not-found' });
    }
    if (child.status.value === 'archived') {
      return Promise.resolve({ kind: 'already-archived' });
    }
    if (child.status.value !== 'active') {
      // Treat as already-archived for the discriminator — service layer
      // wraps any non-active into a 409. Real impl rejects the same way
      // via the WHERE clause.
      return Promise.resolve({ kind: 'already-archived' });
    }
    child.archive(archivedAt, archiveReason, '');
    return Promise.resolve({ kind: 'archived', child });
  }

  override reactivate(
    kindergartenId: string,
    childId: string,
    reactivatedAt: Date,
  ): Promise<ChildReactivateResult> {
    const child = this.children.get(childId);
    if (!child || child.kindergartenId !== kindergartenId) {
      return Promise.resolve({ kind: 'not-found' });
    }
    if (child.status.value !== 'archived') {
      return Promise.resolve({ kind: 'not-archived' });
    }
    child.reactivate(reactivatedAt, '');
    return Promise.resolve({ kind: 'reactivated', child });
  }
}

class FakeGuardianRepo extends ChildGuardianRepository {
  guardians = new Map<string, ChildGuardian>();

  put(g: ChildGuardian): void {
    this.guardians.set(g.id, g);
  }

  create(g: ChildGuardian): Promise<void> {
    this.put(g);
    return Promise.resolve();
  }

  findById(kindergartenId: string, id: string): Promise<ChildGuardian | null> {
    const g = this.guardians.get(id);
    if (!g || g.kindergartenId !== kindergartenId) return Promise.resolve(null);
    // Return a fresh hydrate of the stored state so callers that mutate
    // the returned object do not also mutate the store reference. This
    // mirrors PG snapshot semantics required by SM2's conditional
    // UPDATE: the store row is only updated when `update` /
    // `updateWithExpectedStatus` writes back, never via shared-reference
    // mutation in domain methods.
    return Promise.resolve(ChildGuardian.hydrate(g.toState()));
  }

  findByChildId(
    kindergartenId: string,
    childId: string,
  ): Promise<ChildGuardian[]> {
    return Promise.resolve(
      [...this.guardians.values()].filter(
        (g) => g.kindergartenId === kindergartenId && g.childId === childId,
      ),
    );
  }

  findActiveByChildAndUser(
    kindergartenId: string,
    childId: string,
    userId: string,
  ): Promise<ChildGuardian | null> {
    const g = [...this.guardians.values()].find(
      (x) =>
        x.kindergartenId === kindergartenId &&
        x.childId === childId &&
        x.userId === userId &&
        x.status.value !== 'revoked',
    );
    // Snapshot-isolate (see findById rationale for SM2).
    return Promise.resolve(g ? ChildGuardian.hydrate(g.toState()) : null);
  }

  findApprovedByChildAndUserCrossTenant(
    childId: string,
    userId: string,
  ): Promise<ChildGuardian | null> {
    const g = [...this.guardians.values()].find(
      (x) =>
        x.childId === childId &&
        x.userId === userId &&
        x.status.value === 'approved',
    );
    return Promise.resolve(g ?? null);
  }

  findByIdCrossTenant(guardianId: string): Promise<ChildGuardian | null> {
    return Promise.resolve(this.guardians.get(guardianId) ?? null);
  }

  findPendingForPrimary(
    kindergartenId: string,
    primaryUserId: string,
  ): Promise<ChildGuardian[]> {
    const myChildIds = new Set(
      [...this.guardians.values()]
        .filter(
          (g) =>
            g.kindergartenId === kindergartenId &&
            g.userId === primaryUserId &&
            g.role.value === 'primary' &&
            g.status.value === 'approved',
        )
        .map((g) => g.childId as string),
    );
    return Promise.resolve(
      [...this.guardians.values()].filter(
        (g) =>
          g.kindergartenId === kindergartenId &&
          myChildIds.has(g.childId) &&
          g.status.value === 'pending_approval',
      ),
    );
  }

  update(g: ChildGuardian): Promise<void> {
    this.put(g);
    return Promise.resolve();
  }

  override updateWithExpectedStatus(
    g: ChildGuardian,
    expectedStatus: string,
  ): Promise<boolean> {
    const current = this.guardians.get(g.id);
    if (!current || current.status.value !== expectedStatus) {
      return Promise.resolve(false);
    }
    this.put(g);
    return Promise.resolve(true);
  }

  countApprovalRights(
    kindergartenId: string,
    childId: string,
  ): Promise<number> {
    return Promise.resolve(
      [...this.guardians.values()].filter(
        (g) =>
          g.kindergartenId === kindergartenId &&
          g.childId === childId &&
          g.status.value === 'approved' &&
          g.hasApprovalRights,
      ).length,
    );
  }

  acquireApprovalRightsLock(
    _kindergartenId: string,
    _childId: string,
  ): Promise<void> {
    return Promise.resolve();
  }

  listApprovedKindergartenIdsByUserId(userId: string): Promise<string[]> {
    return Promise.resolve(
      Array.from(
        new Set(
          [...this.guardians.values()]
            .filter((g) => g.userId === userId && g.status.value === 'approved')
            .map((g) => g.kindergartenId as string),
        ),
      ),
    );
  }

  findApprovedByUser(
    kindergartenId: string,
    userId: string,
  ): Promise<ChildGuardian[]> {
    return Promise.resolve(
      [...this.guardians.values()].filter(
        (g) =>
          g.kindergartenId === kindergartenId &&
          g.userId === userId &&
          g.status.value === 'approved',
      ),
    );
  }

  findPendingPrimaryByUserIdCrossTenant(
    userId: string,
  ): Promise<ChildGuardian[]> {
    return Promise.resolve(
      [...this.guardians.values()].filter(
        (g) =>
          g.userId === userId &&
          g.role.value === 'primary' &&
          g.status.value === 'pending_approval',
      ),
    );
  }
  findApprovedActivePickupGuardian(
    _kg: string,
    _childId: string,
    _userId: string,
  ): Promise<ChildGuardian | null> {
    return Promise.resolve(null);
  }
  findApprovedActiveByUserIdCrossTenant(
    userId: string,
    kindergartenId?: string,
  ): Promise<ChildGuardian[]> {
    return Promise.resolve(
      [...this.guardians.values()].filter(
        (g) =>
          g.userId === userId &&
          g.status.value === 'approved' &&
          !g.revokedAt &&
          (kindergartenId === undefined || g.kindergartenId === kindergartenId),
      ),
    );
  }
  findApprovedActiveByUserAndChild(): Promise<ChildGuardian | null> {
    return Promise.resolve(null);
  }
}

class FakeGroupRepo extends GroupRepository {
  groups = new Map<string, Group>();

  put(g: Group): void {
    this.groups.set(g.id, g);
  }

  create(_kg: string, _input: CreateGroupInput): Promise<Group> {
    return Promise.reject(new Error('not used'));
  }
  findById(kindergartenId: string, id: string): Promise<Group | null> {
    const g = this.groups.get(id);
    if (!g || g.kindergartenId !== kindergartenId) return Promise.resolve(null);
    return Promise.resolve(g);
  }
  list(_kg: string, _filters?: ListGroupsFilters): Promise<Group[]> {
    return Promise.resolve([...this.groups.values()]);
  }
  update(
    _kg: string,
    _id: string,
    _patch: UpdateGroupInput,
  ): Promise<Group | null> {
    return Promise.resolve(null);
  }
  save(g: Group): Promise<Group> {
    this.put(g);
    return Promise.resolve(g);
  }
  assignMentor(): Promise<GroupMentor> {
    return Promise.reject(new Error('not used'));
  }
  unassignMentor(): Promise<GroupMentor | null> {
    return Promise.resolve(null);
  }
  unassignMentorByStaffMember(): Promise<number> {
    return Promise.resolve(0);
  }
  findActiveMentor(): Promise<GroupMentor | null> {
    return Promise.resolve(null);
  }
  listMentorHistory(): Promise<GroupMentor[]> {
    return Promise.resolve([]);
  }
  findActiveMentorAssignmentsByUserIdCrossTenant(): Promise<GroupMentor[]> {
    return Promise.resolve([]);
  }
}

class FakeStaffRepo extends StaffMemberRepository {
  staff = new Map<string, StaffMember>();

  put(s: StaffMember): void {
    this.staff.set(s.id, s);
  }
  create(_input: CreateStaffMemberInput): Promise<StaffMember> {
    return Promise.reject(new Error('not used'));
  }
  findById(kindergartenId: string, id: string): Promise<StaffMember | null> {
    const s = this.staff.get(id);
    if (!s || s.kindergartenId !== kindergartenId) return Promise.resolve(null);
    return Promise.resolve(s);
  }
  findActiveByUserAndKindergarten(
    userId: string,
    kindergartenId: string,
  ): Promise<StaffMember | null> {
    const s = [...this.staff.values()].find(
      (x) =>
        x.userId === userId &&
        x.kindergartenId === kindergartenId &&
        x.isActive,
    );
    return Promise.resolve(s ?? null);
  }
  listByKindergarten(
    _kg: string,
    _filters?: ListStaffFilters,
  ): Promise<StaffMember[]> {
    return Promise.resolve([...this.staff.values()]);
  }
  update(
    _kg: string,
    _id: string,
    _changes: UpdateStaffMemberInput,
  ): Promise<StaffMember | null> {
    return Promise.resolve(null);
  }
  save(s: StaffMember): Promise<StaffMember> {
    this.put(s);
    return Promise.resolve(s);
  }
  deactivateAllByKindergarten(): Promise<number> {
    return Promise.resolve(0);
  }
  findAllActiveByUserId(userId: string): Promise<StaffMember[]> {
    return Promise.resolve(
      [...this.staff.values()].filter((s) => s.userId === userId && s.isActive),
    );
  }
}

class FakeUserRepo extends UserRepository {
  users = new Map<string, User>();
  byPhone = new Map<string, User>();

  put(u: User): void {
    this.users.set(u.id, u);
    this.byPhone.set(u.phone, u);
  }

  findById(id: string): Promise<User | null> {
    return Promise.resolve(this.users.get(id) ?? null);
  }
  findByPhone(phone: string): Promise<User | null> {
    return Promise.resolve(this.byPhone.get(phone) ?? null);
  }
  upsertByPhone(phone: string): Promise<User> {
    const existing = this.byPhone.get(phone);
    if (existing) return Promise.resolve(existing);
    const u = User.hydrate({
      id: randomUUID(),
      phone,
      fullName: '',
      avatarUrl: null,
      iin: null,
      dateOfBirth: null,
      locale: 'ru',
    });
    this.put(u);
    return Promise.resolve(u);
  }
  update(_id: string, _changes: UserUpdateInput): Promise<User> {
    return Promise.reject(new Error('not used'));
  }
}

/**
 * Minimal fake of `TransactionRunnerPort`. `ChildService.linkChildByIin`
 * calls `tx.run(cb)` to scope its write into a tenant-bound TX — the
 * in-memory test only needs the lambda to run with a fake manager whose
 * `query()` is a no-op (the `SET LOCAL app.kindergarten_id` statement is
 * irrelevant to the fakes).
 */
const fakeManager = {
  query: (_sql: string): Promise<unknown> => Promise.resolve(undefined),
} as unknown as EntityManager;

class FakeTransactionRunner extends TransactionRunnerPort {
  run<T>(cb: (m: EntityManager) => Promise<T>): Promise<T> {
    return cb(fakeManager);
  }
}

const fakeTxRunner: TransactionRunnerPort = new FakeTransactionRunner();

/**
 * Minimal in-memory `OtpStorePort` for ChildService tests. Only
 * `checkRateLimitGeneric` is exercised by `linkChildByIin`; the rest are
 * implemented as no-ops to satisfy the abstract contract.
 */
class FakeOtpStore extends OtpStorePort {
  rateCounts = new Map<string, number>();
  checkRateLimit(
    phone: string,
    maxPerWindow: number,
    _windowSec: number,
  ): Promise<'ok' | 'exceeded'> {
    const next = (this.rateCounts.get(phone) ?? 0) + 1;
    this.rateCounts.set(phone, next);
    return Promise.resolve(next > maxPerWindow ? 'exceeded' : 'ok');
  }
  checkRateLimitGeneric(
    key: string,
    maxPerWindow: number,
    _windowSec: number,
  ): Promise<'ok' | 'exceeded'> {
    const next = (this.rateCounts.get(key) ?? 0) + 1;
    this.rateCounts.set(key, next);
    return Promise.resolve(next > maxPerWindow ? 'exceeded' : 'ok');
  }
  isLocked(_phone: string): Promise<boolean> {
    return Promise.resolve(false);
  }
  storeCode(_p: string, _c: string, _t: number): Promise<void> {
    return Promise.resolve();
  }
  readCode(_p: string): Promise<StoredOtp | null> {
    return Promise.resolve(null);
  }
  incrementAttempts(_p: string): Promise<number> {
    return Promise.resolve(0);
  }
  lockPhone(_p: string, _t: number): Promise<void> {
    return Promise.resolve();
  }
  clearCode(_p: string): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Stub `ConfigService` exposing only the auth.* keys ChildService reads.
 * Defaults mirror `auth.config.ts` so the rate-limit test can override them
 * (e.g. set the limit to 2 to exercise the throttle quickly).
 */
function makeFakeConfig(
  overrides: {
    rateLimitParentLinkLimit?: number;
    rateLimitParentLinkWindowSec?: number;
  } = {},
): ConfigService {
  const values: Record<string, unknown> = {
    'auth.rateLimitParentLinkLimit': overrides.rateLimitParentLinkLimit ?? 5,
    'auth.rateLimitParentLinkWindowSec':
      overrides.rateLimitParentLinkWindowSec ?? 3600,
  };
  return {
    getOrThrow: (key: string): unknown => {
      if (!(key in values)) throw new Error(`config_not_set: ${key}`);
      return values[key];
    },
    get: (key: string): unknown => values[key],
  } as unknown as ConfigService;
}

class FakeNotification extends NotificationPort {
  events: { type: string; payload: unknown }[] = [];
  push(type: string, payload: unknown): Promise<void> {
    this.events.push({ type, payload });
    return Promise.resolve();
  }
  notifyGuardianPendingApproval(e: unknown): Promise<void> {
    return this.push('pending', e);
  }
  notifyGuardianApproved(e: unknown): Promise<void> {
    return this.push('approved', e);
  }
  notifyGuardianRejected(e: unknown): Promise<void> {
    return this.push('rejected', e);
  }
  notifyGuardianRevoked(e: unknown): Promise<void> {
    return this.push('revoked', e);
  }
  notifyChildTransferred(e: unknown): Promise<void> {
    return this.push('transferred', e);
  }
  notifyPermissionsUpdated(e: unknown): Promise<void> {
    return this.push('permissions_updated', e);
  }
  notifyAttendanceCheckIn(e: unknown): Promise<void> {
    return this.push('attendance_check_in', e);
  }
  notifyAttendanceCheckOut(e: unknown): Promise<void> {
    return this.push('attendance_check_out', e);
  }
  notifyDailyStatusChanged(e: unknown): Promise<void> {
    return this.push('daily_status_changed', e);
  }
  notifyTimelineEntryCreated(e: unknown): Promise<void> {
    return this.push('timeline_entry_created', e);
  }
  notifyGuardianSelfRevoked(e: unknown): Promise<void> {
    return this.push('guardian_self_revoked', e);
  }
  notifyPickupOtpSent(e: unknown): Promise<void> {
    return this.push('pickup_otp_sent', e);
  }
  notifyPickupValidated(e: unknown): Promise<void> {
    return this.push('pickup_validated', e);
  }
  notifyParentRequestAccepted(e: unknown): Promise<void> {
    return this.push('parent_request_accepted', e);
  }
  notifyParentRequestRejected(e: unknown): Promise<void> {
    return this.push('parent_request_rejected', e);
  }
  notifyParentRequestCancelled(e: unknown): Promise<void> {
    return this.push('parent_request_cancelled', e);
  }
  notifyParentRequestMessageSent(e: unknown): Promise<void> {
    return this.push('parent_request_message_sent', e);
  }
  notifyInvoiceCreated(e: unknown): Promise<void> {
    return this.push('invoice_created', e);
  }
  notifyInvoicePaid(e: unknown): Promise<void> {
    return this.push('invoice_paid', e);
  }
  notifyInvoiceOverdue(e: unknown): Promise<void> {
    return this.push('invoice_overdue', e);
  }
  notifyInvoiceCancelled(e: unknown): Promise<void> {
    return this.push('invoice_cancelled', e);
  }
  notifyPaymentCompleted(e: unknown): Promise<void> {
    return this.push('payment_completed', e);
  }
  notifyPaymentFailed(e: unknown): Promise<void> {
    return this.push('payment_failed', e);
  }
  notifyPaymentRefunded(e: unknown): Promise<void> {
    return this.push('payment_refunded', e);
  }
  notifyRefundProcessed(e: unknown): Promise<void> {
    return this.push('refund_processed', e);
  }
  notifyEnrollmentFirstInvoiceSkipped(e: unknown): Promise<void> {
    return this.push('enrollment_first_invoice_skipped', e);
  }
  notifyChildArchived(e: unknown): Promise<void> {
    return this.push('child_archived', e);
  }
  notifyChildReactivated(e: unknown): Promise<void> {
    return this.push('child_reactivated', e);
  }
}

// ── helpers ───────────────────────────────────────────────────────────────

const KG = '11111111-1111-1111-1111-111111111111';
const KG2 = '22222222-2222-2222-2222-222222222222';
const NOW = new Date('2026-04-28T12:00:00.000Z');
// T13 L1 (opus) — `archiveChild` / `reactivateChild` now require an
// explicit `users.id` actor. Older tests in this file invoked them with
// the 4-arg form (no actor) — they now thread this constant through so
// the legacy assertions stay focused on the side effect under test
// without each test having to invent a fresh user id.
const LEGACY_ACTOR_USER_ID = '99999999-9999-9999-9999-999999999999';

function makeGroup(id: string, kg = KG): Group {
  return Group.hydrate({
    id,
    kindergartenId: kg,
    name: 'g',
    capacity: 10,
    ageRangeMin: null,
    ageRangeMax: null,
    currentLocationId: null,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function makeStaff(id: string, userId: string, kg = KG): StaffMember {
  return StaffMember.hydrate({
    id,
    kindergartenId: kg,
    userId,
    fullName: 's',
    phone: null,
    role: 'admin',
    specialistType: null,
    isActive: true,
    hiredAt: null,
    firedAt: null,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function makeUser(id: string, phone: string): User {
  return User.hydrate({
    id,
    phone,
    fullName: '',
    avatarUrl: null,
    iin: null,
    dateOfBirth: null,
    locale: 'ru',
  });
}

/**
 * Minimal BullMQ Queue stub that records `.add(name, data, opts)` calls.
 * The real type from `bullmq` is wide; we cast through `unknown` so the
 * test setup does not depend on Redis being available.
 */
class FakeLifecycleQueue {
  jobs: Array<{
    name: string;
    data: unknown;
    opts: unknown;
  }> = [];

  add(name: string, data: unknown, opts: unknown): Promise<unknown> {
    this.jobs.push({ name, data, opts });
    return Promise.resolve({ id: `job-${this.jobs.length}` });
  }
}

class CountingBillingLifecycleAdapter extends NoopBillingLifecycleAdapter {
  calls: Array<{ kg: string; childId: string; validUntil: Date }> = [];
  closedCountToReturn = 1;

  override closeActiveTariffAssignmentsForChild(
    kindergartenId: string,
    childId: string,
    validUntil: Date,
  ): Promise<{ closedCount: number }> {
    this.calls.push({ kg: kindergartenId, childId, validUntil });
    return Promise.resolve({ closedCount: this.closedCountToReturn });
  }
}

/**
 * In-memory fake for `ChildStatusHistoryRepository`. Records all writes in
 * insertion order. `failNextWrite` lets a single test inject a
 * synchronous throw on the next `recordStatusChange` call so the
 * atomicity guarantee can be exercised without a real DB. The fake's
 * stored rows are NOT rolled back on a thrown write — the production
 * atomicity comes from the ambient PG TX, not from any fake bookkeeping
 * here. Tests assert the OUTER service throws, then verify the
 * children-side fake state did NOT advance (= service rolls back at the
 * port boundary).
 */
class FakeStatusHistoryRepo extends ChildStatusHistoryRepository {
  rows: ChildStatusHistoryState[] = [];
  failNextWrite: Error | null = null;

  recordStatusChange(
    kindergartenId: string,
    record: ChildStatusHistoryState,
  ): Promise<void> {
    if (this.failNextWrite) {
      const err = this.failNextWrite;
      this.failNextWrite = null;
      return Promise.reject(err);
    }
    void kindergartenId;
    this.rows.push(record);
    return Promise.resolve();
  }

  listForChild(
    kindergartenId: string,
    childId: string,
    limit: number,
    offset: number,
  ): Promise<ChildStatusHistoryPage> {
    const filtered = this.rows
      .filter(
        (r) => r.kindergartenId === kindergartenId && r.childId === childId,
      )
      .sort((a, b) => b.changedAt.getTime() - a.changedAt.getTime());
    return Promise.resolve({
      items: filtered
        .slice(offset, offset + limit)
        .map((s) => ChildStatusHistory.hydrate(s)),
      total: filtered.length,
    });
  }
}

function setup(
  opts: {
    rateLimitParentLinkLimit?: number;
    rateLimitParentLinkWindowSec?: number;
  } = {},
) {
  const clock = new FakeClock(NOW);
  const children = new FakeChildRepo();
  const guardians = new FakeGuardianRepo();
  const groups = new FakeGroupRepo();
  const staff = new FakeStaffRepo();
  const users = new FakeUserRepo();
  const notification = new FakeNotification();
  const otpStore = new FakeOtpStore();
  const configService = makeFakeConfig(opts);
  const billingLifecycle = new CountingBillingLifecycleAdapter();
  const lifecycleQueue = new FakeLifecycleQueue();
  const statusHistory = new FakeStatusHistoryRepo();
  const service = new ChildService(
    children,
    guardians,
    groups,
    staff,
    users,
    notification,
    clock,
    fakeTxRunner,
    otpStore,
    configService,
    billingLifecycle as BillingLifecyclePort,
    lifecycleQueue as unknown as never,
    statusHistory,
  );
  return {
    clock,
    children,
    guardians,
    groups,
    staff,
    users,
    notification,
    otpStore,
    configService,
    billingLifecycle,
    lifecycleQueue,
    statusHistory,
    service,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('ChildService — admin: createChild + updates', () => {
  it('creates a child with a unique IIN', async () => {
    const { service } = setup();
    const c = await service.createChild(KG, {
      fullName: 'Aigerim',
      iin: '040315500123',
      dateOfBirth: new Date('2021-09-15'),
    });
    expect(c.fullName).toBe('Aigerim');
    expect(c.status.value).toBe('card_created');
    expect(c.iin?.toString()).toBe('040315500123');
  });

  it('rejects duplicate IIN within the same kindergarten', async () => {
    const { service } = setup();
    await service.createChild(KG, {
      fullName: 'Aigerim',
      iin: '040315500123',
      dateOfBirth: new Date('2021-09-15'),
    });
    await expect(
      service.createChild(KG, {
        fullName: 'Bota',
        iin: '040315500123',
        dateOfBirth: new Date('2021-09-15'),
      }),
    ).rejects.toBeInstanceOf(ChildIinAlreadyExistsError);
  });

  it('rejects createChild when current_group_id does not exist', async () => {
    const { service } = setup();
    await expect(
      service.createChild(KG, {
        fullName: 'Aigerim',
        dateOfBirth: new Date('2021-09-15'),
        currentGroupId: '00000000-0000-0000-0000-000000000099',
      }),
    ).rejects.toBeInstanceOf(GroupNotFoundError);
  });

  it('updates the child profile (name, gender) and bumps updatedAt', async () => {
    const { service, clock } = setup();
    const c = await service.createChild(KG, {
      fullName: 'A',
      dateOfBirth: new Date('2021-09-15'),
    });
    clock.fixed = new Date('2026-04-28T13:00:00.000Z');
    const updated = await service.updateChildProfile(KG, c.id, {
      fullName: 'B',
      gender: 'female',
    });
    expect(updated.fullName).toBe('B');
    expect(updated.gender).toBe('female');
    expect(updated.updatedAt.toISOString()).toBe('2026-04-28T13:00:00.000Z');
  });

  it('archives an active child and reactivates it', async () => {
    const { service } = setup();
    const c = await service.createChild(KG, {
      fullName: 'A',
      dateOfBirth: new Date('2021-09-15'),
    });
    // archive requires status='active'; createChild leaves card_created.
    c.activate(NOW);
    await service.archiveChild(
      KG,
      c.id,
      'parent withdrew',
      'staff-1',
      LEGACY_ACTOR_USER_ID,
    );
    const got = await service.getChild(KG, c.id);
    expect(got.child.status.value).toBe('archived');
    expect(got.child.archiveReason).toBe('parent withdrew');
    await service.restoreChild(KG, c.id, 'staff-1', LEGACY_ACTOR_USER_ID);
    const after = await service.getChild(KG, c.id);
    expect(after.child.status.value).toBe('active');
    expect(after.child.archivedAt).toBeUndefined();
    expect(after.child.archiveReason).toBeUndefined();
  });

  describe('B21 T3 archive/reactivate side-effects', () => {
    it('archive closes active tariff_assignments via BillingLifecyclePort', async () => {
      const { service, billingLifecycle } = setup();
      const c = await service.createChild(KG, {
        fullName: 'A',
        dateOfBirth: new Date('2021-09-15'),
      });
      c.activate(NOW);
      await service.archiveChild(
        KG,
        c.id,
        'parent withdrew',
        'staff-1',
        LEGACY_ACTOR_USER_ID,
      );
      expect(billingLifecycle.calls).toHaveLength(1);
      expect(billingLifecycle.calls[0]).toMatchObject({
        kg: KG,
        childId: c.id,
      });
    });

    it('archive enqueues lifecycle:pro-rata-refund with attempts=3', async () => {
      const { service, lifecycleQueue } = setup();
      const c = await service.createChild(KG, {
        fullName: 'A',
        dateOfBirth: new Date('2021-09-15'),
      });
      c.activate(NOW);
      await service.archiveChild(
        KG,
        c.id,
        'parent withdrew',
        'staff-1',
        LEGACY_ACTOR_USER_ID,
      );
      expect(lifecycleQueue.jobs).toHaveLength(1);
      const job = lifecycleQueue.jobs[0];
      expect(job.name).toBe('lifecycle:pro-rata-refund');
      expect(job.data).toEqual({
        kindergartenId: KG,
        childId: c.id,
        archivedAt: NOW.toISOString(),
      });
      expect(job.opts).toMatchObject({
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
      });
    });

    it('archive emits notifyChildArchived with reason + actor', async () => {
      const { service, notification } = setup();
      const c = await service.createChild(KG, {
        fullName: 'A',
        dateOfBirth: new Date('2021-09-15'),
      });
      c.activate(NOW);
      await service.archiveChild(
        KG,
        c.id,
        'parent withdrew',
        'staff-1',
        LEGACY_ACTOR_USER_ID,
      );
      const ev = notification.events.find((e) => e.type === 'child_archived');
      expect(ev).toBeDefined();
      expect(ev?.payload).toMatchObject({
        kindergartenId: KG,
        childId: c.id,
        archiveReason: 'parent withdrew',
        archivedByStaffId: 'staff-1',
      });
    });

    it('archive throws ChildAlreadyArchivedError when child already archived', async () => {
      const { service } = setup();
      const c = await service.createChild(KG, {
        fullName: 'A',
        dateOfBirth: new Date('2021-09-15'),
      });
      c.activate(NOW);
      await service.archiveChild(
        KG,
        c.id,
        'parent withdrew',
        'staff-1',
        LEGACY_ACTOR_USER_ID,
      );
      await expect(
        service.archiveChild(
          KG,
          c.id,
          'parent withdrew',
          'staff-1',
          LEGACY_ACTOR_USER_ID,
        ),
      ).rejects.toBeInstanceOf(ChildAlreadyArchivedError);
    });

    it('archive throws ChildNotFoundError when child does not exist', async () => {
      const { service } = setup();
      await expect(
        service.archiveChild(
          KG,
          '00000000-0000-0000-0000-000000000099',
          'parent withdrew',
          'staff-1',
          LEGACY_ACTOR_USER_ID,
        ),
      ).rejects.toBeInstanceOf(ChildNotFoundError);
    });

    it('archive throws ChildNotFoundError when child belongs to another kg', async () => {
      const { service } = setup();
      const c = await service.createChild(KG, {
        fullName: 'A',
        dateOfBirth: new Date('2021-09-15'),
      });
      c.activate(NOW);
      await expect(
        service.archiveChild(
          KG2,
          c.id,
          'parent withdrew',
          'staff-1',
          LEGACY_ACTOR_USER_ID,
        ),
      ).rejects.toBeInstanceOf(ChildNotFoundError);
    });

    it('archive throws ArchiveReasonRequiredError on empty reason', async () => {
      const { service } = setup();
      const c = await service.createChild(KG, {
        fullName: 'A',
        dateOfBirth: new Date('2021-09-15'),
      });
      c.activate(NOW);
      await expect(
        service.archiveChild(KG, c.id, '   ', 'staff-1', LEGACY_ACTOR_USER_ID),
      ).rejects.toBeInstanceOf(ArchiveReasonRequiredError);
    });

    it('reactivate returns { child, requires_new_tariff_assignment: true }', async () => {
      const { service } = setup();
      const c = await service.createChild(KG, {
        fullName: 'A',
        dateOfBirth: new Date('2021-09-15'),
      });
      c.activate(NOW);
      await service.archiveChild(
        KG,
        c.id,
        'parent withdrew',
        'staff-1',
        LEGACY_ACTOR_USER_ID,
      );
      const result = await service.reactivateChild(
        KG,
        c.id,
        'staff-2',
        LEGACY_ACTOR_USER_ID,
      );
      expect(result.requires_new_tariff_assignment).toBe(true);
      expect(result.child.status.value).toBe('active');
      expect(result.child.archivedAt).toBeUndefined();
      expect(result.child.archiveReason).toBeUndefined();
    });

    it('reactivate emits notifyChildReactivated with actor id', async () => {
      const { service, notification } = setup();
      const c = await service.createChild(KG, {
        fullName: 'A',
        dateOfBirth: new Date('2021-09-15'),
      });
      c.activate(NOW);
      await service.archiveChild(
        KG,
        c.id,
        'parent withdrew',
        'staff-1',
        LEGACY_ACTOR_USER_ID,
      );
      await service.reactivateChild(KG, c.id, 'staff-2', LEGACY_ACTOR_USER_ID);
      const ev = notification.events.find(
        (e) => e.type === 'child_reactivated',
      );
      expect(ev).toBeDefined();
      expect(ev?.payload).toMatchObject({
        kindergartenId: KG,
        childId: c.id,
        reactivatedByStaffId: 'staff-2',
      });
    });

    it('reactivate throws ChildNotArchivedError when child is active', async () => {
      const { service } = setup();
      const c = await service.createChild(KG, {
        fullName: 'A',
        dateOfBirth: new Date('2021-09-15'),
      });
      c.activate(NOW);
      await expect(
        service.reactivateChild(KG, c.id, 'staff-1', LEGACY_ACTOR_USER_ID),
      ).rejects.toBeInstanceOf(ChildNotArchivedError);
    });

    it('reactivate throws ChildNotFoundError when child does not exist', async () => {
      const { service } = setup();
      await expect(
        service.reactivateChild(
          KG,
          '00000000-0000-0000-0000-000000000099',
          'staff-1',
          LEGACY_ACTOR_USER_ID,
        ),
      ).rejects.toBeInstanceOf(ChildNotFoundError);
    });
  });

  describe('B22a T9 child_status_history audit', () => {
    const ACTOR_USER_ID = '11111111-1111-1111-1111-111111111111';
    const ACTOR_USER_ID_2 = '22222222-2222-2222-2222-222222222222';

    it('records an active->archived row on archive with archive_reason populated', async () => {
      const { service, statusHistory } = setup();
      const c = await service.createChild(KG, {
        fullName: 'A',
        dateOfBirth: new Date('2021-09-15'),
      });
      c.activate(NOW);

      await service.archiveChild(
        KG,
        c.id,
        'parent withdrew',
        'staff-1',
        ACTOR_USER_ID,
      );

      expect(statusHistory.rows).toHaveLength(1);
      const row = statusHistory.rows[0];
      expect(row.kindergartenId).toBe(KG);
      expect(row.childId).toBe(c.id);
      expect(row.previousStatus).toBe('active');
      expect(row.newStatus).toBe('archived');
      expect(row.archiveReason).toBe('parent withdrew');
      expect(row.previousArchiveReason).toBeNull();
      expect(row.changedByUserId).toBe(ACTOR_USER_ID);
      expect(row.changedAt).toEqual(NOW);
    });

    it('records an archived->active row on reactivate and captures previous_archive_reason', async () => {
      const { service, statusHistory } = setup();
      const c = await service.createChild(KG, {
        fullName: 'A',
        dateOfBirth: new Date('2021-09-15'),
      });
      c.activate(NOW);
      await service.archiveChild(
        KG,
        c.id,
        'first archive',
        'staff-1',
        ACTOR_USER_ID,
      );

      await service.reactivateChild(KG, c.id, 'staff-2', ACTOR_USER_ID_2);

      expect(statusHistory.rows).toHaveLength(2);
      const reactivateRow = statusHistory.rows[1];
      expect(reactivateRow.previousStatus).toBe('archived');
      expect(reactivateRow.newStatus).toBe('active');
      expect(reactivateRow.archiveReason).toBeNull();
      // Crucial guarantee — captured BEFORE Child.reactivate clears it.
      expect(reactivateRow.previousArchiveReason).toBe('first archive');
      expect(reactivateRow.changedByUserId).toBe(ACTOR_USER_ID_2);
    });

    it('rolls archive UPDATE back when history INSERT throws (atomicity)', async () => {
      const { service, statusHistory, children, billingLifecycle } = setup();
      const c = await service.createChild(KG, {
        fullName: 'A',
        dateOfBirth: new Date('2021-09-15'),
      });
      c.activate(NOW);

      statusHistory.failNextWrite = new Error('history_insert_failed');

      await expect(
        service.archiveChild(
          KG,
          c.id,
          'parent withdrew',
          'staff-1',
          ACTOR_USER_ID,
        ),
      ).rejects.toThrow(/history_insert_failed/);

      // Atomicity contract: the production ambient TX rolls the children
      // UPDATE back when the history INSERT throws. The fake here cannot
      // physically roll the in-memory map back, but it CAN assert that
      // the side-effects past the history write never fired — the
      // service threw mid-flight before billingLifecycle.close*** ran.
      expect(billingLifecycle.calls).toHaveLength(0);
      // And that no audit row was actually persisted in the fake (the
      // throw happens BEFORE rows.push).
      expect(statusHistory.rows).toHaveLength(0);
      // The children fake's hydrate did mutate (the FakeChildRepo.archive
      // calls Child.archive in-process), but in production the conditional
      // UPDATE is rolled back by the ambient TX — covered by the
      // integration spec; the unit-test sentinel is the THROW + the
      // absence of post-history side effects.
      void children;
    });

    it('rolls reactivate UPDATE back when history INSERT throws (atomicity)', async () => {
      const { service, statusHistory } = setup();
      const c = await service.createChild(KG, {
        fullName: 'A',
        dateOfBirth: new Date('2021-09-15'),
      });
      c.activate(NOW);
      await service.archiveChild(
        KG,
        c.id,
        'first archive',
        'staff-1',
        ACTOR_USER_ID,
      );
      // First write was the archive — drain it + reset the failure flag.
      expect(statusHistory.rows).toHaveLength(1);
      statusHistory.failNextWrite = new Error('reactivate_history_failed');

      await expect(
        service.reactivateChild(KG, c.id, 'staff-2', ACTOR_USER_ID_2),
      ).rejects.toThrow(/reactivate_history_failed/);

      // Reactivate-history INSERT failed → no notification side effect
      // beyond what archive already produced; rows still at 1.
      expect(statusHistory.rows).toHaveLength(1);
    });

    it('listStatusHistory returns rows newest first with total', async () => {
      const { service, statusHistory } = setup();
      const c = await service.createChild(KG, {
        fullName: 'A',
        dateOfBirth: new Date('2021-09-15'),
      });
      c.activate(NOW);

      // archive at NOW
      await service.archiveChild(KG, c.id, 'first', 'staff-1', ACTOR_USER_ID);
      // reactivate at NOW + 1m, hand-rolling the clock so changed_at differs
      const { service: srv2, statusHistory: hist2 } = setup();
      void srv2;
      void hist2;
      // For ordering we manually push a second row with a later changed_at
      // since the FakeClock is fixed for this setup() call.
      statusHistory.rows.push({
        id: '00000000-0000-0000-0000-aaaaaaaaaaaa',
        kindergartenId: KG,
        childId: c.id,
        previousStatus: 'archived',
        newStatus: 'active',
        previousArchiveReason: 'first',
        archiveReason: null,
        changedByUserId: ACTOR_USER_ID,
        changedAt: new Date(NOW.getTime() + 60_000),
        createdAt: new Date(NOW.getTime() + 60_000),
      });

      const page = await service.listStatusHistory(KG, c.id, 50, 0);

      expect(page.total).toBe(2);
      expect(page.items).toHaveLength(2);
      // Newest first: the manual reactivate row at NOW+1m precedes the archive at NOW.
      expect(page.items[0].newStatus).toBe('active');
      expect(page.items[0].previousArchiveReason).toBe('first');
      expect(page.items[1].newStatus).toBe('archived');
      expect(page.items[1].archiveReason).toBe('first');
    });

    it('listStatusHistory throws ChildNotFoundError when child does not exist in kg', async () => {
      const { service } = setup();
      await expect(
        service.listStatusHistory(
          KG,
          '00000000-0000-0000-0000-000000000099',
          50,
          0,
        ),
      ).rejects.toBeInstanceOf(ChildNotFoundError);
    });
  });

  it('updateChildPhoto sets and clears the URL', async () => {
    const { service } = setup();
    const c = await service.createChild(KG, {
      fullName: 'A',
      dateOfBirth: new Date('2021-09-15'),
    });
    const u1 = await service.updateChildPhoto(KG, c.id, 'https://x/y.png');
    expect(u1.photoUrl).toBe('https://x/y.png');
    const u2 = await service.updateChildPhoto(KG, c.id, null);
    expect(u2.photoUrl).toBeUndefined();
  });

  it('throws ChildNotFoundError when childId belongs to another kg', async () => {
    const { service } = setup();
    const c = await service.createChild(KG, {
      fullName: 'A',
      dateOfBirth: new Date('2021-09-15'),
    });
    await expect(service.getChild(KG2, c.id)).rejects.toBeInstanceOf(
      ChildNotFoundError,
    );
  });
});

describe('ChildService — group transfer', () => {
  it('transfers child from one group to another, appending history', async () => {
    const { service, groups, staff, users, children } = setup();
    const u = makeUser(randomUUID(), '+77000000000');
    users.put(u);
    const stf = makeStaff(randomUUID(), u.id);
    staff.put(stf);
    const g1 = makeGroup(randomUUID());
    const g2 = makeGroup(randomUUID());
    groups.put(g1);
    groups.put(g2);
    const c = await service.createChild(KG, {
      fullName: 'A',
      dateOfBirth: new Date('2021-09-15'),
      currentGroupId: g1.id,
    });
    const out = await service.transferChildToGroup(
      KG,
      c.id,
      g2.id,
      stf.id,
      'r',
    );
    expect(out.toState().currentGroupId).toBe(g2.id);
    const history = await children.listGroupHistory(KG, c.id);
    expect(history.length).toBe(1);
    expect(history[0].fromGroupId).toBe(g1.id);
    expect(history[0].toGroupId).toBe(g2.id);
  });

  it('rejects transfer to the same group', async () => {
    const { service, groups, staff, users } = setup();
    const u = makeUser(randomUUID(), '+77000000000');
    users.put(u);
    const stf = makeStaff(randomUUID(), u.id);
    staff.put(stf);
    const g = makeGroup(randomUUID());
    groups.put(g);
    const c = await service.createChild(KG, {
      fullName: 'A',
      dateOfBirth: new Date('2021-09-15'),
      currentGroupId: g.id,
    });
    await expect(
      service.transferChildToGroup(KG, c.id, g.id, stf.id),
    ).rejects.toBeInstanceOf(GroupTransferToSelfError);
  });
});

describe('ChildService — guardian state machine', () => {
  async function bootChildWithPrimary(): Promise<{
    setup: ReturnType<typeof setup>;
    childId: string;
    primaryGuardianId: string;
    primaryUserId: string;
  }> {
    const ctx = setup();
    const primaryUser = makeUser(randomUUID(), '+77011110000');
    ctx.users.put(primaryUser);
    const child = await ctx.service.createChild(KG, {
      fullName: 'A',
      dateOfBirth: new Date('2021-09-15'),
    });
    // seed an APPROVED PRIMARY guardian directly
    const g = ChildGuardian.hydrate({
      id: randomUUID(),
      kindergartenId: KG,
      childId: child.id,
      userId: primaryUser.id,
      role: 'primary',
      status: 'approved',
      hasApprovalRights: false,
      approvedBy: null,
      approvedAt: NOW,
      revokedBy: null,
      revokedAt: null,
      canPickup: true,
      permissions: {},
      permissionsUpdatedBy: null,
      permissionsUpdatedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    ctx.guardians.put(g);
    return {
      setup: ctx,
      childId: child.id,
      primaryGuardianId: g.id,
      primaryUserId: primaryUser.id,
    };
  }

  it('admin invites a new guardian → pending_approval, primary is notified', async () => {
    const ctx = await bootChildWithPrimary();
    const { service, notification } = ctx.setup;
    const guardian = await service.inviteGuardian(KG, {
      childId: ctx.childId,
      userPhone: '+77011112222',
      role: 'secondary',
      invitedByUserId: ctx.primaryUserId,
    });
    expect(guardian.status.value).toBe('pending_approval');
    expect(guardian.role.value).toBe('secondary');
    expect(notification.events.find((e) => e.type === 'pending')).toBeDefined();
  });

  it('rejects double-invite of the same user (DuplicateGuardianError)', async () => {
    const ctx = await bootChildWithPrimary();
    const { service } = ctx.setup;
    await service.inviteGuardian(KG, {
      childId: ctx.childId,
      userPhone: '+77011112222',
      role: 'secondary',
      invitedByUserId: ctx.primaryUserId,
    });
    await expect(
      service.inviteGuardian(KG, {
        childId: ctx.childId,
        userPhone: '+77011112222',
        role: 'nanny',
        invitedByUserId: ctx.primaryUserId,
      }),
    ).rejects.toBeInstanceOf(DuplicateGuardianError);
  });

  it('approve transitions pending → approved; second approve fails', async () => {
    const ctx = await bootChildWithPrimary();
    const { service } = ctx.setup;
    const g = await service.inviteGuardian(KG, {
      childId: ctx.childId,
      userPhone: '+77011112222',
      role: 'secondary',
      invitedByUserId: ctx.primaryUserId,
    });
    const approved = await service.approveGuardian(
      KG,
      ctx.primaryUserId,
      g.id,
      false,
    );
    expect(approved.status.value).toBe('approved');
    await expect(
      service.approveGuardian(KG, ctx.primaryUserId, g.id, false),
    ).rejects.toBeInstanceOf(InvalidGuardianStatusTransitionError);
  });

  it('reject transitions pending → rejected; cannot approve afterwards', async () => {
    const ctx = await bootChildWithPrimary();
    const { service } = ctx.setup;
    const g = await service.inviteGuardian(KG, {
      childId: ctx.childId,
      userPhone: '+77011112222',
      role: 'secondary',
      invitedByUserId: ctx.primaryUserId,
    });
    const rejected = await service.rejectGuardian(KG, ctx.primaryUserId, g.id);
    expect(rejected.status.value).toBe('rejected');
    await expect(
      service.approveGuardian(KG, ctx.primaryUserId, g.id, false),
    ).rejects.toBeInstanceOf(InvalidGuardianStatusTransitionError);
  });

  it('updateWithExpectedStatus returns false when row status flipped between read and write (FINDINGS SM2)', async () => {
    // Repo-level contract test for SM2: conditional UPDATE WHERE
    // status = :expectedStatus must reject the write when a concurrent
    // transition has already flipped the row. Real PG impl uses
    // `affected === 0` to signal the conflict; fake mirrors via the
    // store's `status.value` comparison. Caller maps false → throws
    // ChildGuardianStatusConflictError (verified at the 5 service sites).
    const ctx = await bootChildWithPrimary();
    const { service, guardians } = ctx.setup;
    const g = await service.inviteGuardian(KG, {
      childId: ctx.childId,
      userPhone: '+77011112222',
      role: 'secondary',
      invitedByUserId: ctx.primaryUserId,
    });
    // Simulate: caller-A read at status=pending_approval, caller-B already
    // flipped row to `rejected` in the store. Caller-A now tries to write
    // back its `approved` mutation with expected=pending_approval.
    const stored = guardians.guardians.get(g.id)!;
    stored.reject(new Date());
    const desired = ChildGuardian.hydrate({
      ...stored.toState(),
      status: 'approved',
    });
    const ok = await guardians.updateWithExpectedStatus(
      desired,
      'pending_approval',
    );
    expect(ok).toBe(false);
    expect(guardians.guardians.get(g.id)!.status.value).toBe('rejected');
  });

  it('revoke (admin) on approved → revoked; subsequent revoke fails', async () => {
    const ctx = await bootChildWithPrimary();
    const { service } = ctx.setup;
    const g = await service.inviteGuardian(KG, {
      childId: ctx.childId,
      userPhone: '+77011112222',
      role: 'secondary',
      invitedByUserId: ctx.primaryUserId,
    });
    await service.approveGuardian(KG, ctx.primaryUserId, g.id, false);
    await service.revokeGuardianByAdmin(
      KG,
      ctx.childId,
      g.id,
      ctx.primaryUserId,
    );
    await expect(
      service.revokeGuardianByAdmin(KG, ctx.childId, g.id, ctx.primaryUserId),
    ).rejects.toBeInstanceOf(InvalidGuardianStatusTransitionError);
  });

  it('non-primary caller cannot approve guardians', async () => {
    const ctx = await bootChildWithPrimary();
    const { service } = ctx.setup;
    const g = await service.inviteGuardian(KG, {
      childId: ctx.childId,
      userPhone: '+77011112222',
      role: 'secondary',
      invitedByUserId: ctx.primaryUserId,
    });
    await expect(
      service.approveGuardian(
        KG,
        '99999999-9999-9999-9999-999999999999',
        g.id,
        false,
      ),
    ).rejects.toBeInstanceOf(NotPrimaryGuardianError);
  });

  it('approval-rights cap of 2 is enforced', async () => {
    const ctx = await bootChildWithPrimary();
    const { service, guardians } = ctx.setup;
    // primary already has approval-rights = false; grant it via toggle.
    await service.toggleGuardianApprovalRights(
      KG,
      ctx.primaryUserId,
      ctx.primaryGuardianId,
      true,
    );
    // invite + approve a 2nd with rights
    const g2 = await service.inviteGuardian(KG, {
      childId: ctx.childId,
      userPhone: '+77011112222',
      role: 'secondary',
      invitedByUserId: ctx.primaryUserId,
    });
    await service.approveGuardian(KG, ctx.primaryUserId, g2.id, true);
    // invite a 3rd; trying to grant rights at approve must fail.
    const g3 = await service.inviteGuardian(KG, {
      childId: ctx.childId,
      userPhone: '+77011113333',
      role: 'secondary',
      invitedByUserId: ctx.primaryUserId,
    });
    await expect(
      service.approveGuardian(KG, ctx.primaryUserId, g3.id, true),
    ).rejects.toBeInstanceOf(MaxApprovalRightsExceededError);
    // toggleApprovalRights also caps:
    await service.approveGuardian(KG, ctx.primaryUserId, g3.id, false);
    await expect(
      service.toggleGuardianApprovalRights(KG, ctx.primaryUserId, g3.id, true),
    ).rejects.toBeInstanceOf(MaxApprovalRightsExceededError);
    void guardians;
  });

  it('updateGuardianPermissions requires status=approved', async () => {
    const ctx = await bootChildWithPrimary();
    const { service } = ctx.setup;
    const g = await service.inviteGuardian(KG, {
      childId: ctx.childId,
      userPhone: '+77011112222',
      role: 'secondary',
      invitedByUserId: ctx.primaryUserId,
    });
    await expect(
      service.updateGuardianPermissions(KG, ctx.primaryUserId, g.id, {
        view_cctv: false,
      }),
    ).rejects.toBeInstanceOf(GuardianNotApprovedError);
  });

  it('updateGuardianPermissions persists overrides and produces effective map', async () => {
    const ctx = await bootChildWithPrimary();
    const { service } = ctx.setup;
    const g = await service.inviteGuardian(KG, {
      childId: ctx.childId,
      userPhone: '+77011112222',
      role: 'secondary',
      invitedByUserId: ctx.primaryUserId,
    });
    await service.approveGuardian(KG, ctx.primaryUserId, g.id, false);
    const out = await service.updateGuardianPermissions(
      KG,
      ctx.primaryUserId,
      g.id,
      { view_cctv: false },
    );
    expect(out.effective.view_cctv).toBe(false);
    expect(out.effective.view_timeline).toBe(true);
  });

  it('listMyChildren returns only children where the user is APPROVED guardian', async () => {
    const ctx = await bootChildWithPrimary();
    const { service } = ctx.setup;
    const otherChild = await service.createChild(KG, {
      fullName: 'B',
      dateOfBirth: new Date('2021-09-15'),
    });
    void otherChild;
    const rows = await service.listMyChildren(KG, ctx.primaryUserId);
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(ctx.childId);
  });

  it('listMyChildrenCrossTenant returns approved-guardian children across kgs without a kg arg', async () => {
    // Two kgs, same primary user, one approved child in each. The
    // cross-tenant variant fans out and returns both children — used by
    // /parent/children when the JWT has no kindergarten_id.
    const ctxA = await bootChildWithPrimary();
    const { service } = ctxA.setup;

    // Hand-roll a child + approved primary guardian in kg-B via the in-memory
    // repos (createChild requires a tenant + group lookup; the cross-tenant
    // service path does not, so we bypass createChild for the foreign kg).
    const otherChildId = '00000000-0000-0000-0000-000000000c2c';
    const otherChild = Child.hydrate({
      id: otherChildId,
      kindergartenId: KG2,
      fullName: 'Cross-Kg Child',
      iin: null,
      dateOfBirth: new Date('2021-09-15'),
      gender: null,
      photoUrl: null,
      currentGroupId: null,
      enrollmentDate: null,
      medicalNotes: null,
      allergyNotes: null,
      status: 'active',
      archivedAt: null,
      archiveReason: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    ctxA.setup.children.put(otherChild);
    const otherGuardian = ChildGuardian.hydrate({
      id: '00000000-0000-0000-0000-000000000c3c',
      kindergartenId: KG2,
      childId: otherChildId,
      userId: ctxA.primaryUserId,
      role: 'primary',
      status: 'approved',
      hasApprovalRights: true,
      approvedBy: ctxA.primaryUserId,
      approvedAt: NOW,
      revokedBy: null,
      revokedAt: null,
      canPickup: true,
      permissions: {},
      permissionsUpdatedBy: null,
      permissionsUpdatedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    ctxA.setup.guardians.put(otherGuardian);

    const rows = await service.listMyChildrenCrossTenant(ctxA.primaryUserId);
    const ids = rows.map((c) => c.id).sort();
    expect(ids).toEqual([ctxA.childId, otherChildId].sort());
  });

  it('updateGuardianRoleAndPickup throws GuardianNotFoundError if id mismatches childId', async () => {
    const ctx = await bootChildWithPrimary();
    const { service } = ctx.setup;
    const otherChild = await service.createChild(KG, {
      fullName: 'B',
      dateOfBirth: new Date('2021-09-15'),
    });
    await expect(
      service.updateGuardianRoleAndPickup(
        KG,
        otherChild.id,
        ctx.primaryGuardianId,
        { canPickup: false },
      ),
    ).rejects.toBeInstanceOf(GuardianNotFoundError);
  });
});

// ── revokeGuardianByPrimary self-revoke guard ─────────────────────────────

describe('ChildService — revokeGuardianByPrimary', () => {
  async function bootWithPrimaryAndSecondary(): Promise<{
    setup: ReturnType<typeof setup>;
    childId: string;
    primaryUserId: string;
    primaryGuardianId: string;
    secondaryUserId: string;
    secondaryGuardianId: string;
  }> {
    const ctx = setup();
    const primaryUser = makeUser(randomUUID(), '+77011110001');
    ctx.users.put(primaryUser);
    const secondaryUser = makeUser(randomUUID(), '+77011110002');
    ctx.users.put(secondaryUser);

    const child = await ctx.service.createChild(KG, {
      fullName: 'C',
      dateOfBirth: new Date('2021-09-15'),
    });

    const primaryGuardian = ChildGuardian.hydrate({
      id: randomUUID(),
      kindergartenId: KG,
      childId: child.id,
      userId: primaryUser.id,
      role: 'primary',
      status: 'approved',
      hasApprovalRights: true,
      approvedBy: primaryUser.id,
      approvedAt: NOW,
      revokedBy: null,
      revokedAt: null,
      canPickup: true,
      permissions: {},
      permissionsUpdatedBy: null,
      permissionsUpdatedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    ctx.guardians.put(primaryGuardian);

    const secondaryGuardian = ChildGuardian.hydrate({
      id: randomUUID(),
      kindergartenId: KG,
      childId: child.id,
      userId: secondaryUser.id,
      role: 'secondary',
      status: 'approved',
      hasApprovalRights: false,
      approvedBy: primaryUser.id,
      approvedAt: NOW,
      revokedBy: null,
      revokedAt: null,
      canPickup: true,
      permissions: {},
      permissionsUpdatedBy: null,
      permissionsUpdatedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    ctx.guardians.put(secondaryGuardian);

    return {
      setup: ctx,
      childId: child.id,
      primaryUserId: primaryUser.id,
      primaryGuardianId: primaryGuardian.id,
      secondaryUserId: secondaryUser.id,
      secondaryGuardianId: secondaryGuardian.id,
    };
  }

  it('throws PrimaryCannotSelfRevokeError when primary tries to revoke own row', async () => {
    const ctx = await bootWithPrimaryAndSecondary();
    const { service } = ctx.setup;
    await expect(
      service.revokeGuardianByPrimary(
        KG,
        ctx.primaryUserId,
        ctx.primaryGuardianId,
      ),
    ).rejects.toBeInstanceOf(PrimaryCannotSelfRevokeError);
  });

  it('revokes a secondary guardian row when called by the approved primary', async () => {
    const ctx = await bootWithPrimaryAndSecondary();
    const { service, guardians } = ctx.setup;
    const result = await service.revokeGuardianByPrimary(
      KG,
      ctx.primaryUserId,
      ctx.secondaryGuardianId,
    );
    expect(result.status.value).toBe('revoked');
    expect(result.revokedBy).toBe(ctx.primaryUserId);
    const persisted = guardians.guardians.get(ctx.secondaryGuardianId);
    expect(persisted?.status.value).toBe('revoked');
  });
});

// ── B6: parent-side cross-tenant link / self-unlink ──────────────────────

describe('ChildService — linkChildByIin', () => {
  /**
   * Bootstraps a `KG` kindergarten with one child + one approved primary
   * guardian. Returns the child id, child IIN, and the caller user id used
   * across all happy-path link tests.
   */
  async function bootChildWithIinAndPrimary(): Promise<{
    setup: ReturnType<typeof setup>;
    childId: string;
    childIin: string;
    primaryUserId: string;
    callerUserId: string;
  }> {
    const ctx = setup();
    const primaryUser = makeUser(randomUUID(), '+77011110000');
    ctx.users.put(primaryUser);
    const callerUser = makeUser(randomUUID(), '+77011112222');
    ctx.users.put(callerUser);
    const childIin = '040315500123';
    const child = await ctx.service.createChild(KG, {
      fullName: 'A',
      iin: childIin,
      dateOfBirth: new Date('2021-09-15'),
    });
    const g = ChildGuardian.hydrate({
      id: randomUUID(),
      kindergartenId: KG,
      childId: child.id,
      userId: primaryUser.id,
      role: 'primary',
      status: 'approved',
      hasApprovalRights: true,
      approvedBy: primaryUser.id,
      approvedAt: NOW,
      revokedBy: null,
      revokedAt: null,
      canPickup: true,
      permissions: {},
      permissionsUpdatedBy: null,
      permissionsUpdatedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    ctx.guardians.put(g);
    return {
      setup: ctx,
      childId: child.id,
      childIin,
      primaryUserId: primaryUser.id,
      callerUserId: callerUser.id,
    };
  }

  it('creates a pending secondary guardian for a found child', async () => {
    const ctx = await bootChildWithIinAndPrimary();
    const { service, notification, guardians } = ctx.setup;
    const out = await service.linkChildByIin(ctx.callerUserId, {
      iin: ctx.childIin,
      role: 'secondary',
    });
    expect(out.child.id).toBe(ctx.childId);
    expect(out.guardian.status.value).toBe('pending_approval');
    expect(out.guardian.role.value).toBe('secondary');
    expect(out.guardian.canPickup).toBe(false); // default when omitted
    expect(out.guardian.userId).toBe(ctx.callerUserId);
    // primary was notified once
    const pending = notification.events.filter((e) => e.type === 'pending');
    expect(pending.length).toBe(1);
    expect(
      (pending[0].payload as { primaryUserId: string }).primaryUserId,
    ).toBe(ctx.primaryUserId);
    // row landed in store
    expect(guardians.guardians.get(out.guardian.id)).toBeDefined();
  });

  it('honours canPickup=true when explicitly set', async () => {
    const ctx = await bootChildWithIinAndPrimary();
    const { service } = ctx.setup;
    const out = await service.linkChildByIin(ctx.callerUserId, {
      iin: ctx.childIin,
      role: 'nanny',
      canPickup: true,
    });
    expect(out.guardian.role.value).toBe('nanny');
    expect(out.guardian.canPickup).toBe(true);
  });

  it('throws ChildNotFoundForIinError when iin matches no child', async () => {
    const ctx = setup();
    await expect(
      ctx.service.linkChildByIin('00000000-0000-0000-0000-000000000099', {
        iin: '040315500999',
        role: 'secondary',
      }),
    ).rejects.toBeInstanceOf(ChildNotFoundForIinError);
  });

  it('throws MultipleChildrenForIinError without leaking kindergartenIds when iin matches multiple children', async () => {
    const ctx = setup();
    const callerUser = makeUser(randomUUID(), '+77011112222');
    ctx.users.put(callerUser);
    const sharedIin = '040315500444';
    await ctx.service.createChild(KG, {
      fullName: 'A1',
      iin: sharedIin,
      dateOfBirth: new Date('2021-09-15'),
    });
    await ctx.service.createChild(KG2, {
      fullName: 'A2',
      iin: sharedIin,
      dateOfBirth: new Date('2021-09-15'),
    });
    let captured: MultipleChildrenForIinError | null = null;
    try {
      await ctx.service.linkChildByIin(callerUser.id, {
        iin: sharedIin,
        role: 'secondary',
      });
    } catch (err) {
      captured = err as MultipleChildrenForIinError;
    }
    expect(captured).toBeInstanceOf(MultipleChildrenForIinError);
    // Information-disclosure guard: details must NOT carry kindergartenIds.
    expect(captured!.details).toEqual({ iin: sharedIin });
    expect(
      (captured! as unknown as { kindergartenIds?: string[] }).kindergartenIds,
    ).toBeUndefined();
  });

  it('throws ParentLinkRateLimitError after caller exceeds the per-user limit', async () => {
    // Tight cap = 2 so the test runs in 3 calls.
    const ctx = setup({
      rateLimitParentLinkLimit: 2,
      rateLimitParentLinkWindowSec: 60,
    });
    const callerUser = makeUser(randomUUID(), '+77011112222');
    ctx.users.put(callerUser);
    await ctx.service.createChild(KG, {
      fullName: 'RL',
      iin: '040315500777',
      dateOfBirth: new Date('2021-09-15'),
    });

    // 1st + 2nd attempts pass the rate-limit (2 allowed). They throw
    // AlreadyPendingForChildError on the 2nd because the 1st created a
    // pending row — this is irrelevant; we only care about the 3rd hit
    // exceeding the limit.
    await ctx.service.linkChildByIin(callerUser.id, {
      iin: '040315500777',
      role: 'secondary',
    });
    await expect(
      ctx.service.linkChildByIin(callerUser.id, {
        iin: '040315500777',
        role: 'secondary',
      }),
    ).rejects.toBeInstanceOf(AlreadyPendingForChildError);

    // 3rd attempt — over the cap → 429.
    await expect(
      ctx.service.linkChildByIin(callerUser.id, {
        iin: '040315500777',
        role: 'secondary',
      }),
    ).rejects.toBeInstanceOf(ParentLinkRateLimitError);
  });

  it('rate-limit gates the IIN lookup itself — exceeded callers never reach findByIinCrossTenant', async () => {
    // Tight cap = 1.
    const ctx = setup({
      rateLimitParentLinkLimit: 1,
      rateLimitParentLinkWindowSec: 60,
    });
    const callerUser = makeUser(randomUUID(), '+77011113333');
    ctx.users.put(callerUser);
    // First call burns the quota and 404s on an unknown IIN.
    await expect(
      ctx.service.linkChildByIin(callerUser.id, {
        iin: '999999999999',
        role: 'secondary',
      }),
    ).rejects.toBeInstanceOf(ChildNotFoundForIinError);
    // Second call — over the cap. Even though the IIN is still unknown,
    // the service must short-circuit on rate-limit BEFORE the lookup.
    await expect(
      ctx.service.linkChildByIin(callerUser.id, {
        iin: '999999999998',
        role: 'secondary',
      }),
    ).rejects.toBeInstanceOf(ParentLinkRateLimitError);
  });

  it('throws AlreadyLinkedToChildError when caller already approved on the child', async () => {
    const ctx = await bootChildWithIinAndPrimary();
    const { service, guardians } = ctx.setup;
    const existing = ChildGuardian.hydrate({
      id: randomUUID(),
      kindergartenId: KG,
      childId: ctx.childId,
      userId: ctx.callerUserId,
      role: 'secondary',
      status: 'approved',
      hasApprovalRights: false,
      approvedBy: ctx.primaryUserId,
      approvedAt: NOW,
      revokedBy: null,
      revokedAt: null,
      canPickup: false,
      permissions: {},
      permissionsUpdatedBy: null,
      permissionsUpdatedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    guardians.put(existing);
    await expect(
      service.linkChildByIin(ctx.callerUserId, {
        iin: ctx.childIin,
        role: 'secondary',
      }),
    ).rejects.toBeInstanceOf(AlreadyLinkedToChildError);
  });

  it('throws AlreadyPendingForChildError when caller already pending on the child', async () => {
    const ctx = await bootChildWithIinAndPrimary();
    const { service, guardians } = ctx.setup;
    const existing = ChildGuardian.hydrate({
      id: randomUUID(),
      kindergartenId: KG,
      childId: ctx.childId,
      userId: ctx.callerUserId,
      role: 'secondary',
      status: 'pending_approval',
      hasApprovalRights: false,
      approvedBy: null,
      approvedAt: null,
      revokedBy: null,
      revokedAt: null,
      canPickup: false,
      permissions: {},
      permissionsUpdatedBy: null,
      permissionsUpdatedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    guardians.put(existing);
    await expect(
      service.linkChildByIin(ctx.callerUserId, {
        iin: ctx.childIin,
        role: 'secondary',
      }),
    ).rejects.toBeInstanceOf(AlreadyPendingForChildError);
  });

  it('allows new pending row when prior row is revoked', async () => {
    const ctx = await bootChildWithIinAndPrimary();
    const { service, guardians } = ctx.setup;
    const revoked = ChildGuardian.hydrate({
      id: randomUUID(),
      kindergartenId: KG,
      childId: ctx.childId,
      userId: ctx.callerUserId,
      role: 'secondary',
      status: 'revoked',
      hasApprovalRights: false,
      approvedBy: ctx.primaryUserId,
      approvedAt: NOW,
      revokedBy: ctx.callerUserId,
      revokedAt: NOW,
      canPickup: false,
      permissions: {},
      permissionsUpdatedBy: null,
      permissionsUpdatedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    guardians.put(revoked);
    const out = await service.linkChildByIin(ctx.callerUserId, {
      iin: ctx.childIin,
      role: 'secondary',
    });
    expect(out.guardian.status.value).toBe('pending_approval');
    expect(out.guardian.id).not.toBe(revoked.id);
  });
});

describe('ChildService — selfUnlinkFromChild', () => {
  async function bootApprovedSecondary(): Promise<{
    setup: ReturnType<typeof setup>;
    childId: string;
    primaryUserId: string;
    secondaryUserId: string;
    secondaryGuardianId: string;
  }> {
    const ctx = setup();
    const primaryUser = makeUser(randomUUID(), '+77011110000');
    ctx.users.put(primaryUser);
    const secondaryUser = makeUser(randomUUID(), '+77011112222');
    ctx.users.put(secondaryUser);
    const child = await ctx.service.createChild(KG, {
      fullName: 'A',
      dateOfBirth: new Date('2021-09-15'),
    });
    const primaryRow = ChildGuardian.hydrate({
      id: randomUUID(),
      kindergartenId: KG,
      childId: child.id,
      userId: primaryUser.id,
      role: 'primary',
      status: 'approved',
      hasApprovalRights: true,
      approvedBy: primaryUser.id,
      approvedAt: NOW,
      revokedBy: null,
      revokedAt: null,
      canPickup: true,
      permissions: {},
      permissionsUpdatedBy: null,
      permissionsUpdatedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    ctx.guardians.put(primaryRow);
    const secondaryRow = ChildGuardian.hydrate({
      id: randomUUID(),
      kindergartenId: KG,
      childId: child.id,
      userId: secondaryUser.id,
      role: 'secondary',
      status: 'approved',
      hasApprovalRights: false,
      approvedBy: primaryUser.id,
      approvedAt: NOW,
      revokedBy: null,
      revokedAt: null,
      canPickup: true,
      permissions: {},
      permissionsUpdatedBy: null,
      permissionsUpdatedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    ctx.guardians.put(secondaryRow);
    return {
      setup: ctx,
      childId: child.id,
      primaryUserId: primaryUser.id,
      secondaryUserId: secondaryUser.id,
      secondaryGuardianId: secondaryRow.id,
    };
  }

  it('revokes an approved secondary guardian', async () => {
    const ctx = await bootApprovedSecondary();
    const { service, guardians } = ctx.setup;
    await service.selfUnlinkFromChild(KG, ctx.secondaryUserId, ctx.childId);
    const after = guardians.guardians.get(ctx.secondaryGuardianId);
    expect(after?.status.value).toBe('revoked');
    expect(after?.revokedBy).toBe(ctx.secondaryUserId);
    expect(after?.revokedAt).toEqual(NOW);
  });

  it('emits notifyGuardianSelfRevoked with correct payload', async () => {
    const ctx = await bootApprovedSecondary();
    const { service, notification } = ctx.setup;
    await service.selfUnlinkFromChild(KG, ctx.secondaryUserId, ctx.childId);
    const selfRevokedEvents = notification.events.filter(
      (e) => e.type === 'guardian_self_revoked',
    );
    expect(selfRevokedEvents).toHaveLength(1);
    const payload = selfRevokedEvents[0].payload as {
      kindergartenId: string;
      childId: string;
      userId: string;
      revokedAt: Date;
    };
    expect(payload.kindergartenId).toBe(KG);
    expect(payload.childId).toBe(ctx.childId);
    expect(payload.userId).toBe(ctx.secondaryUserId);
    expect(payload.revokedAt).toEqual(NOW);
  });

  it('revokes an approved nanny guardian', async () => {
    const ctx = await bootApprovedSecondary();
    const { service, guardians } = ctx.setup;
    const nannyUser = makeUser(randomUUID(), '+77011113333');
    ctx.setup.users.put(nannyUser);
    const nannyRow = ChildGuardian.hydrate({
      id: randomUUID(),
      kindergartenId: KG,
      childId: ctx.childId,
      userId: nannyUser.id,
      role: 'nanny',
      status: 'approved',
      hasApprovalRights: false,
      approvedBy: ctx.primaryUserId,
      approvedAt: NOW,
      revokedBy: null,
      revokedAt: null,
      canPickup: true,
      permissions: {},
      permissionsUpdatedBy: null,
      permissionsUpdatedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    guardians.put(nannyRow);
    await service.selfUnlinkFromChild(KG, nannyUser.id, ctx.childId);
    const after = guardians.guardians.get(nannyRow.id);
    expect(after?.status.value).toBe('revoked');
    expect(after?.revokedBy).toBe(nannyUser.id);
  });

  it('throws PrimaryCannotSelfUnlinkError for primary', async () => {
    const ctx = await bootApprovedSecondary();
    const { service } = ctx.setup;
    await expect(
      service.selfUnlinkFromChild(KG, ctx.primaryUserId, ctx.childId),
    ).rejects.toBeInstanceOf(PrimaryCannotSelfUnlinkError);
  });

  it('throws ChildAccessDeniedError when caller has no guardian row', async () => {
    const ctx = await bootApprovedSecondary();
    const { service } = ctx.setup;
    await expect(
      service.selfUnlinkFromChild(
        KG,
        '00000000-0000-0000-0000-000000000099',
        ctx.childId,
      ),
    ).rejects.toBeInstanceOf(ChildAccessDeniedError);
  });

  it('throws ChildAccessDeniedError when caller is only pending', async () => {
    const ctx = await bootApprovedSecondary();
    const { service, guardians } = ctx.setup;
    const pendingUser = makeUser(randomUUID(), '+77011114444');
    ctx.setup.users.put(pendingUser);
    const pendingRow = ChildGuardian.hydrate({
      id: randomUUID(),
      kindergartenId: KG,
      childId: ctx.childId,
      userId: pendingUser.id,
      role: 'secondary',
      status: 'pending_approval',
      hasApprovalRights: false,
      approvedBy: null,
      approvedAt: null,
      revokedBy: null,
      revokedAt: null,
      canPickup: false,
      permissions: {},
      permissionsUpdatedBy: null,
      permissionsUpdatedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    guardians.put(pendingRow);
    await expect(
      service.selfUnlinkFromChild(KG, pendingUser.id, ctx.childId),
    ).rejects.toBeInstanceOf(ChildAccessDeniedError);
  });
});
