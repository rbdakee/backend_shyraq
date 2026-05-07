import { ChildId } from '@/shared-kernel/domain/value-objects/child-id.vo';
import { GuardianRelation } from '@/shared-kernel/domain/value-objects/guardian-relation.vo';
import { KindergartenId } from '@/shared-kernel/domain/value-objects/kindergarten-id.vo';
import { UserId } from '@/shared-kernel/domain/value-objects/user-id.vo';
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
import {
  GroupRepository,
  CreateGroupInput,
  ListGroupsFilters,
  UpdateGroupInput,
} from '@/modules/group/infrastructure/persistence/group.repository';
import { GroupMentor } from '@/modules/group/domain/entities/group-mentor.entity';
import { User } from '@/modules/users/domain/entities/user.entity';
import {
  UserRepository,
  UserUpdateInput,
} from '@/modules/users/infrastructure/persistence/user.repository';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import {
  PushNotificationPort,
  PushPayload,
  PushTarget,
} from '@/shared-kernel/domain/push-notification.port';
import { OutboxEvent } from './domain/entities/outbox-event.entity';
import {
  EVENT_RECIPIENT_RESOLVERS,
  EVENT_TEMPLATES,
  NotificationDispatcher,
  SavepointRollback,
} from './notification-dispatcher.service';
import {
  NotificationPreference,
  NotificationPreferenceFlags,
  NotificationPreferenceRepository,
  UpsertPreferenceItem,
} from './notification-preference.repository';
import {
  NotificationCreateInput,
  NotificationRepository,
  NotificationRow,
} from './notification.repository';
import {
  PushToken,
  PushTokenRepository,
  PushTokenSummary,
  PushTokenUpsertInput,
} from './push-token.repository';
import { classifyPushError } from './push-error-classifier';
import { WsBroadcaster } from './ws-broadcaster.port';

const KG = '11111111-1111-1111-1111-111111111111';
const CHILD = '22222222-2222-2222-2222-222222222222';
const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const USER_NANNY = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const GROUP_NEW = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const NOW = new Date('2026-05-01T09:00:00.000Z');

class FixedClock extends ClockPort {
  constructor(private fixed: Date) {
    super();
  }
  now(): Date {
    return this.fixed;
  }
}

// ── Fakes ────────────────────────────────────────────────────────────────

class FakeGuardianRepo
  extends ChildGuardianRepository
  implements ChildGuardianRepository
{
  rowsByChild = new Map<string, ChildGuardian[]>();

  setGuardiansForChild(childId: string, guardians: ChildGuardian[]): void {
    this.rowsByChild.set(childId, guardians);
  }

  create(): Promise<void> {
    return Promise.resolve();
  }
  findById(): Promise<ChildGuardian | null> {
    return Promise.resolve(null);
  }
  findByChildId(_kg: string, childId: string): Promise<ChildGuardian[]> {
    return Promise.resolve(this.rowsByChild.get(childId) ?? []);
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
    const list = this.rowsByChild.get(childId) ?? [];
    const r =
      list.find((g) => {
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

class FakePreferenceRepo extends NotificationPreferenceRepository {
  flagsByUser = new Map<string, NotificationPreferenceFlags>();

  set(userId: string, flags: NotificationPreferenceFlags): void {
    this.flagsByUser.set(userId, flags);
  }

  findByUserIdsAndEventKey(
    userIds: string[],
    _eventKey: string,
  ): Promise<Map<string, NotificationPreferenceFlags>> {
    const m = new Map<string, NotificationPreferenceFlags>();
    for (const u of userIds) {
      const v = this.flagsByUser.get(u);
      if (v) m.set(u, v);
    }
    return Promise.resolve(m);
  }

  // Stubs for T7 methods — not exercised by dispatcher tests.
  listForUser(): Promise<NotificationPreference[]> {
    return Promise.resolve([]);
  }

  upsertMany(
    _userId: string,
    _items: UpsertPreferenceItem[],
  ): Promise<NotificationPreference[]> {
    return Promise.resolve([]);
  }
}

class FakePushTokenRepo extends PushTokenRepository {
  byUser = new Map<string, PushTokenSummary[]>();
  deletedTokenIds: string[] = [];

  set(userId: string, tokens: PushTokenSummary[]): void {
    this.byUser.set(userId, tokens);
  }

  findByUserIds(userIds: string[]): Promise<PushTokenSummary[]> {
    const out: PushTokenSummary[] = [];
    for (const u of userIds) {
      const ts = this.byUser.get(u) ?? [];
      out.push(...ts);
    }
    return Promise.resolve(out);
  }

  // Stubs for T7 methods — not exercised by dispatcher tests.
  upsert(_input: PushTokenUpsertInput): Promise<PushToken> {
    return Promise.reject(new Error('not implemented'));
  }

  deleteByIdAndUserId(_id: string, _userId: string): Promise<boolean> {
    return Promise.resolve(false);
  }

  deleteById(id: string): Promise<void> {
    this.deletedTokenIds.push(id);
    // Best-effort: simulate the row being gone after the delete by removing
    // it from the in-memory state, so a follow-up findByUserIds wouldn't
    // return it. Tests don't currently re-fetch but keeps the fake honest.
    for (const [user, list] of this.byUser.entries()) {
      this.byUser.set(
        user,
        list.filter((t) => t.id !== id),
      );
    }
    return Promise.resolve();
  }
}

class FakeNotificationRepo extends NotificationRepository {
  rows: NotificationCreateInput[] = [];
  failNext = false;

  createMany(rows: NotificationCreateInput[]): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('history_insert_failed'));
    }
    this.rows.push(...rows);
    return Promise.resolve();
  }

  // Stubs for T7 methods — not exercised by dispatcher tests.
  listForUser(): Promise<NotificationRow[]> {
    return Promise.resolve([]);
  }

  markRead(): Promise<NotificationRow | null> {
    return Promise.resolve(null);
  }

  markAllRead(): Promise<number> {
    return Promise.resolve(0);
  }
}

class RecordingPushPort extends PushNotificationPort {
  calls: { target: PushTarget; payload: PushPayload }[] = [];
  /** Map of token-id → error to throw on send. */
  errorsByTokenId = new Map<string, Error>();

  failTokenId(id: string, err: Error): void {
    this.errorsByTokenId.set(id, err);
  }

  send(target: PushTarget, payload: PushPayload): Promise<void> {
    this.calls.push({ target, payload });
    for (const t of target.tokens) {
      const err = this.errorsByTokenId.get(t.id);
      if (err) return Promise.reject(err);
    }
    return Promise.resolve();
  }
}

class RecordingWsBroadcaster extends WsBroadcaster {
  userBroadcasts: { userId: string; eventName: string; payload: unknown }[] =
    [];

  broadcastToUser(userId: string, eventName: string, payload: unknown): void {
    this.userBroadcasts.push({ userId, eventName, payload });
  }
  broadcastToChild(): void {}
  broadcastToGroup(): void {}
}

class FakeChildRepo extends ChildRepository {
  byId = new Map<string, Child>();

  set(child: Child): void {
    this.byId.set(child.id, child);
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

class FakeGroupRepo extends GroupRepository {
  byId = new Map<string, Group>();

  set(group: Group): void {
    this.byId.set(group.id, group);
  }

  create(_kg: string, _i: CreateGroupInput): Promise<Group> {
    return Promise.reject(new Error('not used'));
  }
  findById(_kg: string, id: string): Promise<Group | null> {
    return Promise.resolve(this.byId.get(id) ?? null);
  }
  list(_kg: string, _f?: ListGroupsFilters): Promise<Group[]> {
    return Promise.resolve([]);
  }
  update(
    _kg: string,
    _id: string,
    _p: UpdateGroupInput,
  ): Promise<Group | null> {
    return Promise.resolve(null);
  }
  save(g: Group): Promise<Group> {
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

class FakeUserRepo extends UserRepository {
  byId = new Map<string, User>();

  set(user: User): void {
    this.byId.set(user.id, user);
  }

  findById(id: string): Promise<User | null> {
    return Promise.resolve(this.byId.get(id) ?? null);
  }
  findByPhone(): Promise<User | null> {
    return Promise.resolve(null);
  }
  upsertByPhone(): Promise<User> {
    return Promise.reject(new Error('not used'));
  }
  update(_id: string, _c: UserUpdateInput): Promise<User> {
    return Promise.reject(new Error('not used'));
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

function approvedGuardian(
  userId: string,
  role: 'primary' | 'secondary' | 'nanny' = 'primary',
): ChildGuardian {
  return ChildGuardian.hydrate({
    id: '00000000-0000-0000-0000-000000000001',
    kindergartenId: KG,
    childId: CHILD,
    userId,
    role,
    status: 'approved',
    hasApprovalRights: false,
    approvedBy: userId,
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
}

function makeChild(fullName = 'Айгерим Сериккызы'): Child {
  return Child.hydrate({
    id: CHILD,
    kindergartenId: KG,
    iin: null,
    fullName,
    dateOfBirth: new Date('2020-01-01T00:00:00.000Z'),
    gender: 'f',
    photoUrl: null,
    status: 'active',
    currentGroupId: null,
    enrollmentDate: null,
    archivedAt: null,
    archiveReason: null,
    medicalNotes: null,
    allergyNotes: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function makeGroup(id: string, name: string): Group {
  return Group.hydrate({
    id,
    kindergartenId: KG,
    name,
    capacity: 20,
    ageRangeMin: null,
    ageRangeMax: null,
    currentLocationId: null,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function makeUser(id: string, fullName: string): User {
  return User.hydrate({
    id,
    phone: '+77770000000',
    fullName,
    avatarUrl: null,
    iin: null,
    dateOfBirth: null,
    locale: 'ru',
  });
}

void ChildId;
void GuardianRelation;
void KindergartenId;
void UserId;

interface Wired {
  dispatcher: NotificationDispatcher;
  guardianRepo: FakeGuardianRepo;
  prefRepo: FakePreferenceRepo;
  tokenRepo: FakePushTokenRepo;
  notificationRepo: FakeNotificationRepo;
  pushPort: RecordingPushPort;
  ws: RecordingWsBroadcaster;
  childRepo: FakeChildRepo;
  groupRepo: FakeGroupRepo;
  userRepo: FakeUserRepo;
}

function wire(): Wired {
  const guardianRepo = new FakeGuardianRepo();
  const prefRepo = new FakePreferenceRepo();
  const tokenRepo = new FakePushTokenRepo();
  const notificationRepo = new FakeNotificationRepo();
  const pushPort = new RecordingPushPort();
  const ws = new RecordingWsBroadcaster();
  const clock = new FixedClock(NOW);
  const childRepo = new FakeChildRepo();
  const groupRepo = new FakeGroupRepo();
  const userRepo = new FakeUserRepo();
  const dispatcher = new NotificationDispatcher(
    guardianRepo,
    prefRepo,
    tokenRepo,
    notificationRepo,
    pushPort,
    ws,
    clock,
    childRepo,
    groupRepo,
    userRepo,
  );
  return {
    dispatcher,
    guardianRepo,
    prefRepo,
    tokenRepo,
    notificationRepo,
    pushPort,
    ws,
    childRepo,
    groupRepo,
    userRepo,
  };
}

function makeAttendanceEvent(): OutboxEvent {
  return OutboxEvent.create(
    {
      id: '99999999-9999-9999-9999-999999999991',
      kindergartenId: KG,
      eventKey: 'attendance.checkin',
      payload: {
        childId: CHILD,
        eventId: 'evt-1',
        recordedAt: NOW.toISOString(),
        recordedByStaffMemberId: null,
      },
    },
    NOW,
  );
}

describe('NotificationDispatcher', () => {
  describe('attendance.checkin happy path', () => {
    it('writes history rows for both guardians but only one push (other has push disabled)', async () => {
      const w = wire();
      w.guardianRepo.setGuardiansForChild(CHILD, [
        approvedGuardian(USER_A, 'primary'),
        approvedGuardian(USER_B, 'secondary'),
      ]);
      w.prefRepo.set(USER_B, { push_enabled: false, in_app_enabled: true });
      w.tokenRepo.set(USER_A, [
        { id: 't1', userId: USER_A, platform: 'ios', token: 'tok-a' },
      ]);
      w.tokenRepo.set(USER_B, [
        { id: 't2', userId: USER_B, platform: 'android', token: 'tok-b' },
      ]);

      const result = await w.dispatcher.dispatch(makeAttendanceEvent());

      expect(result).toEqual({ status: 'dispatched' });
      // Both users get history (in_app default true; B explicitly true).
      expect(w.notificationRepo.rows).toHaveLength(2);
      expect(w.notificationRepo.rows.map((r) => r.userId).sort()).toEqual(
        [USER_A, USER_B].sort(),
      );
      // Only USER_A gets a push (USER_B has push_enabled=false).
      expect(w.pushPort.calls).toHaveLength(1);
      expect(w.pushPort.calls[0].target.userId).toBe(USER_A);
      // WS broadcast happens for both in-app users.
      expect(w.ws.userBroadcasts).toHaveLength(2);
    });
  });

  describe('nanny-policy filter', () => {
    it('lets a nanny receive attendance.checkin', async () => {
      const w = wire();
      w.guardianRepo.setGuardiansForChild(CHILD, [
        approvedGuardian(USER_NANNY, 'nanny'),
      ]);
      w.tokenRepo.set(USER_NANNY, [
        { id: 'tn', userId: USER_NANNY, platform: 'ios', token: 'tok-n' },
      ]);

      const result = await w.dispatcher.dispatch(makeAttendanceEvent());

      expect(result).toEqual({ status: 'dispatched' });
      expect(w.notificationRepo.rows).toHaveLength(1);
      expect(w.pushPort.calls).toHaveLength(1);
    });

    it('skips nanny for guardian.approved (not in nanny allowlist)', async () => {
      const w = wire();
      const event = OutboxEvent.create(
        {
          id: '99999999-9999-9999-9999-999999999992',
          kindergartenId: KG,
          eventKey: 'guardian.approved',
          payload: {
            childId: CHILD,
            guardianUserId: USER_NANNY,
            approvedBy: USER_A,
            hasApprovalRights: false,
          },
        },
        NOW,
      );

      const result = await w.dispatcher.dispatch(event);

      expect(result).toEqual({ status: 'dispatched' });
      expect(w.notificationRepo.rows).toHaveLength(1);
      expect(w.notificationRepo.rows[0].userId).toBe(USER_NANNY);
    });

    it('drops nanny for non-allowlisted event when nanny is part of child guardians', async () => {
      const w = wire();
      w.guardianRepo.setGuardiansForChild(CHILD, [
        approvedGuardian(USER_A, 'primary'),
        approvedGuardian(USER_NANNY, 'nanny'),
      ]);
      const event = OutboxEvent.create(
        {
          id: '99999999-9999-9999-9999-999999999993',
          kindergartenId: KG,
          eventKey: 'timeline.entry_created',
          payload: {
            childId: CHILD,
            entryId: 'entry-1',
            entryType: 'progress_note',
            entryTime: NOW.toISOString(),
            recordedByStaffMemberId: null,
          },
        },
        NOW,
      );

      const result = await w.dispatcher.dispatch(event);

      expect(result).toEqual({ status: 'dispatched' });
      expect(w.notificationRepo.rows).toHaveLength(1);
      expect(w.notificationRepo.rows[0].userId).toBe(USER_A);
    });

    it('drops nanny for child.transferred (administrative — nannies excluded by policy)', async () => {
      const w = wire();
      w.guardianRepo.setGuardiansForChild(CHILD, [
        approvedGuardian(USER_A, 'primary'),
        approvedGuardian(USER_NANNY, 'nanny'),
      ]);
      w.childRepo.set(makeChild('Айгерим'));
      w.groupRepo.set(makeGroup(GROUP_NEW, 'Радуга'));
      const event = OutboxEvent.create(
        {
          id: '99999999-9999-9999-9999-99999999cccc',
          kindergartenId: KG,
          eventKey: 'child.transferred',
          payload: {
            childId: CHILD,
            fromGroupId: null,
            toGroupId: GROUP_NEW,
            transferredBy: USER_A,
            recipientUserIds: [USER_A, USER_NANNY],
          },
        },
        NOW,
      );

      const result = await w.dispatcher.dispatch(event);

      expect(result).toEqual({ status: 'dispatched' });
      // Only USER_A is on the history. Nanny dropped by policy.
      expect(w.notificationRepo.rows.map((r) => r.userId)).toEqual([USER_A]);
    });

    it('still notifies the nanny user about guardian.revoked when they themselves are the target', async () => {
      // The recipient resolver for guardian.revoked targets a single
      // userId (`guardianUserId`) — the nannyUserIds set is empty, so the
      // policy filter is a no-op even though the event-key is not in the
      // nanny allowlist. Self-events about the nanny ALWAYS reach them.
      const w = wire();
      w.childRepo.set(makeChild('Айгерим'));
      const event = OutboxEvent.create(
        {
          id: '99999999-9999-9999-9999-99999999dddd',
          kindergartenId: KG,
          eventKey: 'guardian.revoked',
          payload: {
            childId: CHILD,
            guardianUserId: USER_NANNY,
            revokedBy: USER_A,
          },
        },
        NOW,
      );

      const result = await w.dispatcher.dispatch(event);

      expect(result).toEqual({ status: 'dispatched' });
      expect(w.notificationRepo.rows.map((r) => r.userId)).toEqual([
        USER_NANNY,
      ]);
    });
  });

  describe('preferences', () => {
    it('skips a user with both push and in_app disabled (no history, no push, no WS)', async () => {
      const w = wire();
      w.guardianRepo.setGuardiansForChild(CHILD, [
        approvedGuardian(USER_A, 'primary'),
      ]);
      w.prefRepo.set(USER_A, { push_enabled: false, in_app_enabled: false });
      w.tokenRepo.set(USER_A, [
        { id: 't1', userId: USER_A, platform: 'ios', token: 'tok-a' },
      ]);

      const result = await w.dispatcher.dispatch(makeAttendanceEvent());

      expect(result).toEqual({ status: 'dispatched' });
      expect(w.notificationRepo.rows).toHaveLength(0);
      expect(w.pushPort.calls).toHaveLength(0);
      expect(w.ws.userBroadcasts).toHaveLength(0);
    });

    it('mixed users: one fully off, one fully on', async () => {
      const w = wire();
      w.guardianRepo.setGuardiansForChild(CHILD, [
        approvedGuardian(USER_A, 'primary'),
        approvedGuardian(USER_B, 'secondary'),
      ]);
      w.prefRepo.set(USER_A, { push_enabled: false, in_app_enabled: false });
      w.tokenRepo.set(USER_B, [
        { id: 'tb', userId: USER_B, platform: 'web', token: 'tok-b' },
      ]);

      const result = await w.dispatcher.dispatch(makeAttendanceEvent());

      expect(result).toEqual({ status: 'dispatched' });
      expect(w.notificationRepo.rows.map((r) => r.userId)).toEqual([USER_B]);
      expect(w.pushPort.calls.map((c) => c.target.userId)).toEqual([USER_B]);
    });
  });

  describe('push edge cases', () => {
    it('does not call push when user has push_enabled=true but no tokens', async () => {
      const w = wire();
      w.guardianRepo.setGuardiansForChild(CHILD, [
        approvedGuardian(USER_A, 'primary'),
      ]);

      const result = await w.dispatcher.dispatch(makeAttendanceEvent());

      expect(result).toEqual({ status: 'dispatched' });
      expect(w.pushPort.calls).toHaveLength(0);
      expect(w.notificationRepo.rows).toHaveLength(1);
    });

    it('on PERMANENT-token error: deletes the token, dispatch still succeeds for the rest', async () => {
      const w = wire();
      w.guardianRepo.setGuardiansForChild(CHILD, [
        approvedGuardian(USER_A, 'primary'),
        approvedGuardian(USER_B, 'secondary'),
      ]);
      w.tokenRepo.set(USER_A, [
        { id: 't-dead', userId: USER_A, platform: 'ios', token: 'tok-a' },
      ]);
      w.tokenRepo.set(USER_B, [
        { id: 't-ok', userId: USER_B, platform: 'android', token: 'tok-b' },
      ]);
      w.pushPort.failTokenId('t-dead', new Error('NotRegistered'));

      const result = await w.dispatcher.dispatch(makeAttendanceEvent());

      expect(result).toEqual({ status: 'dispatched' });
      // Dead token was deleted.
      expect(w.tokenRepo.deletedTokenIds).toEqual(['t-dead']);
      // Both push attempts were made (per-token loop).
      expect(w.pushPort.calls.map((c) => c.target.tokens[0].id).sort()).toEqual(
        ['t-dead', 't-ok'],
      );
    });

    it('on TRANSIENT push error: dispatch returns failed (worker retries)', async () => {
      const w = wire();
      w.guardianRepo.setGuardiansForChild(CHILD, [
        approvedGuardian(USER_A, 'primary'),
      ]);
      w.tokenRepo.set(USER_A, [
        { id: 't1', userId: USER_A, platform: 'ios', token: 'tok-a' },
      ]);
      w.pushPort.failTokenId('t1', new Error('FCM 503 service unavailable'));

      const result = await w.dispatcher.dispatch(makeAttendanceEvent());

      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.reason).toMatch(/push_transient_failures=1/);
      }
      // Token was NOT deleted — transient errors must not drop tokens.
      expect(w.tokenRepo.deletedTokenIds).toEqual([]);
    });

    it('mixed permanent + transient: still failed (transient wins for retry semantics)', async () => {
      const w = wire();
      w.guardianRepo.setGuardiansForChild(CHILD, [
        approvedGuardian(USER_A, 'primary'),
      ]);
      w.tokenRepo.set(USER_A, [
        { id: 't-dead', userId: USER_A, platform: 'ios', token: 'tok-a' },
        { id: 't-blip', userId: USER_A, platform: 'android', token: 'tok-b' },
      ]);
      w.pushPort.failTokenId('t-dead', new Error('NotRegistered'));
      w.pushPort.failTokenId('t-blip', new Error('connect ETIMEDOUT'));

      const result = await w.dispatcher.dispatch(makeAttendanceEvent());

      expect(result.status).toBe('failed');
      expect(w.tokenRepo.deletedTokenIds).toEqual(['t-dead']);
    });
  });

  describe('failure modes', () => {
    it('returns failed when event_key is unknown', async () => {
      const w = wire();
      const event = OutboxEvent.create(
        {
          id: '99999999-9999-9999-9999-999999999994',
          kindergartenId: KG,
          eventKey: 'totally.unknown',
          payload: {},
        },
        NOW,
      );

      const result = await w.dispatcher.dispatch(event);

      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.reason).toMatch(/unknown_event_key/);
      }
    });

    it('returns failed when history insert throws', async () => {
      const w = wire();
      w.guardianRepo.setGuardiansForChild(CHILD, [
        approvedGuardian(USER_A, 'primary'),
      ]);
      w.notificationRepo.failNext = true;

      const result = await w.dispatcher.dispatch(makeAttendanceEvent());

      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.reason).toMatch(/history_insert_failed/);
      }
    });
  });

  describe('empty recipient set', () => {
    it('returns dispatched when no guardians are approved (terminal success, no work)', async () => {
      const w = wire();

      const result = await w.dispatcher.dispatch(makeAttendanceEvent());

      expect(result).toEqual({ status: 'dispatched' });
      expect(w.notificationRepo.rows).toHaveLength(0);
      expect(w.pushPort.calls).toHaveLength(0);
    });
  });

  // ── B9 follow-up: new event-keys ────────────────────────────────────────

  describe('guardian.pending_approval', () => {
    it('targets the primary, renders new-guardian name + child name', async () => {
      const w = wire();
      w.userRepo.set(makeUser(USER_B, 'Алия Адамқызы'));
      const event = OutboxEvent.create(
        {
          id: '99999999-9999-9999-9999-999999999aaa',
          kindergartenId: KG,
          eventKey: 'guardian.pending_approval',
          payload: {
            childId: CHILD,
            childFullName: 'Айгерим Сериккызы',
            primaryUserId: USER_A,
            requesterUserId: USER_B,
            role: 'secondary',
          },
        },
        NOW,
      );

      const result = await w.dispatcher.dispatch(event);

      expect(result).toEqual({ status: 'dispatched' });
      expect(w.notificationRepo.rows).toHaveLength(1);
      const row = w.notificationRepo.rows[0];
      expect(row.userId).toBe(USER_A);
      expect(row.bodyI18n.ru).toContain('Алия Адамқызы');
      expect(row.bodyI18n.ru).toContain('Айгерим Сериккызы');
    });
  });

  describe('guardian.rejected', () => {
    it('targets the rejected user, mentions child name from lookup', async () => {
      const w = wire();
      w.childRepo.set(makeChild('Дамир Бакытов'));
      const event = OutboxEvent.create(
        {
          id: '99999999-9999-9999-9999-999999999bbb',
          kindergartenId: KG,
          eventKey: 'guardian.rejected',
          payload: {
            childId: CHILD,
            guardianUserId: USER_B,
            rejectedBy: USER_A,
          },
        },
        NOW,
      );

      const result = await w.dispatcher.dispatch(event);

      expect(result).toEqual({ status: 'dispatched' });
      expect(w.notificationRepo.rows).toHaveLength(1);
      expect(w.notificationRepo.rows[0].userId).toBe(USER_B);
      expect(w.notificationRepo.rows[0].bodyI18n.ru).toContain('Дамир Бакытов');
    });
  });

  describe('guardian.revoked', () => {
    it('targets the revoked user, mentions child name', async () => {
      const w = wire();
      w.childRepo.set(makeChild('Камила Серикова'));
      const event = OutboxEvent.create(
        {
          id: '99999999-9999-9999-9999-999999999ccc',
          kindergartenId: KG,
          eventKey: 'guardian.revoked',
          payload: {
            childId: CHILD,
            guardianUserId: USER_B,
            revokedBy: USER_A,
          },
        },
        NOW,
      );

      const result = await w.dispatcher.dispatch(event);

      expect(result).toEqual({ status: 'dispatched' });
      expect(w.notificationRepo.rows[0].userId).toBe(USER_B);
      expect(w.notificationRepo.rows[0].bodyI18n.ru).toContain(
        'Камила Серикова',
      );
    });

    it('falls back to a generic placeholder when the child row is gone', async () => {
      const w = wire();
      // No child row registered — lookup returns null.
      const event = OutboxEvent.create(
        {
          id: '99999999-9999-9999-9999-99999999fff0',
          kindergartenId: KG,
          eventKey: 'guardian.revoked',
          payload: {
            childId: CHILD,
            guardianUserId: USER_B,
            revokedBy: USER_A,
          },
        },
        NOW,
      );

      const result = await w.dispatcher.dispatch(event);

      expect(result).toEqual({ status: 'dispatched' });
      // Body still rendered; reason for falling back: child row deleted
      // between enqueue and dispatch must not block the notification.
      expect(w.notificationRepo.rows[0].bodyI18n.ru).toMatch(/ребёнок/);
    });
  });

  describe('child.transferred', () => {
    it('targets all approved guardians (minus nannies) and renders group name', async () => {
      const w = wire();
      w.guardianRepo.setGuardiansForChild(CHILD, [
        approvedGuardian(USER_A, 'primary'),
        approvedGuardian(USER_B, 'secondary'),
      ]);
      w.childRepo.set(makeChild('Ермек Берікұлы'));
      w.groupRepo.set(makeGroup(GROUP_NEW, 'Жұлдыз'));
      const event = OutboxEvent.create(
        {
          id: '99999999-9999-9999-9999-99999999dddd',
          kindergartenId: KG,
          eventKey: 'child.transferred',
          payload: {
            childId: CHILD,
            fromGroupId: null,
            toGroupId: GROUP_NEW,
            transferredBy: USER_A,
            recipientUserIds: [USER_A, USER_B],
          },
        },
        NOW,
      );

      const result = await w.dispatcher.dispatch(event);

      expect(result).toEqual({ status: 'dispatched' });
      expect(w.notificationRepo.rows.map((r) => r.userId).sort()).toEqual(
        [USER_A, USER_B].sort(),
      );
      const ruBody = w.notificationRepo.rows[0].bodyI18n.ru;
      expect(ruBody).toContain('Ермек Берікұлы');
      expect(ruBody).toContain('Жұлдыз');
    });
  });

  describe('guardian.permissions_updated', () => {
    it('targets only the affected user, mentions child name', async () => {
      const w = wire();
      w.childRepo.set(makeChild('Сабина Маратовна'));
      const event = OutboxEvent.create(
        {
          id: '99999999-9999-9999-9999-99999999eeee',
          kindergartenId: KG,
          eventKey: 'guardian.permissions_updated',
          payload: {
            childId: CHILD,
            guardianUserId: USER_B,
            updatedBy: USER_A,
            effectivePermissions: { canPickup: true },
          },
        },
        NOW,
      );

      const result = await w.dispatcher.dispatch(event);

      expect(result).toEqual({ status: 'dispatched' });
      expect(w.notificationRepo.rows.map((r) => r.userId)).toEqual([USER_B]);
      expect(w.notificationRepo.rows[0].bodyI18n.ru).toContain(
        'Сабина Маратовна',
      );
    });
  });

  // ── T7-5 MEDIUM#4: pickup recipient re-validation ──────────────────────

  describe('pickup recipient re-validation (T7-5 MEDIUM#4)', () => {
    function makeOtpSentEvent(requesterUserId: string): OutboxEvent {
      return OutboxEvent.create(
        {
          id: '99999999-9999-9999-9999-99999999aaaa',
          kindergartenId: KG,
          eventKey: 'pickup.otp_sent',
          payload: {
            childId: CHILD,
            pickupRequestId: 'pr-1',
            requesterUserId,
            trustedPersonName: 'Aunt',
          },
        },
        NOW,
      );
    }

    function makeValidatedEvent(requesterUserId: string): OutboxEvent {
      return OutboxEvent.create(
        {
          id: '99999999-9999-9999-9999-99999999bbbb',
          kindergartenId: KG,
          eventKey: 'pickup.validated',
          payload: {
            childId: CHILD,
            pickupRequestId: 'pr-1',
            requesterUserId,
            trustedPersonName: 'Aunt',
            attendanceEventId: 'evt-1',
            validatedAt: NOW.toISOString(),
          },
        },
        NOW,
      );
    }

    it('drops the requester from `pickup.otp_sent` recipients when their guardian-link is no longer approved-active', async () => {
      const w = wire();
      // No active guardian link for USER_A (the requester) — resolver
      // returns empty; dispatcher short-circuits to status='dispatched'
      // with NO history row written.
      const result = await w.dispatcher.dispatch(makeOtpSentEvent(USER_A));
      expect(result).toEqual({ status: 'dispatched' });
      expect(w.notificationRepo.rows).toHaveLength(0);
      expect(w.pushPort.calls).toHaveLength(0);
    });

    it('delivers `pickup.otp_sent` to the requester when their guardian-link is still approved-active', async () => {
      const w = wire();
      w.guardianRepo.setGuardiansForChild(CHILD, [
        approvedGuardian(USER_A, 'primary'),
      ]);
      w.tokenRepo.set(USER_A, [
        { id: 't1', userId: USER_A, platform: 'ios', token: 'tok-a' },
      ]);
      const result = await w.dispatcher.dispatch(makeOtpSentEvent(USER_A));
      expect(result).toEqual({ status: 'dispatched' });
      expect(w.notificationRepo.rows.map((r) => r.userId)).toEqual([USER_A]);
    });

    it('drops a stale requester from `pickup.validated` but still delivers to current approved guardians', async () => {
      const w = wire();
      // USER_B is the current approved guardian; USER_A initiated the
      // request but their link has been revoked (no entry in setGuardiansForChild).
      w.guardianRepo.setGuardiansForChild(CHILD, [
        approvedGuardian(USER_B, 'primary'),
      ]);
      w.tokenRepo.set(USER_B, [
        { id: 't2', userId: USER_B, platform: 'android', token: 'tok-b' },
      ]);
      const result = await w.dispatcher.dispatch(makeValidatedEvent(USER_A));
      expect(result).toEqual({ status: 'dispatched' });
      expect(w.notificationRepo.rows.map((r) => r.userId)).toEqual([USER_B]);
    });
  });

  // ── B12 T6 H1: nanny requester slips through `request.*` ───────────────

  describe('parent-request nanny-requester gate (T6 H1)', () => {
    it('drops a nanny requester from `request.accepted` (request.* is not in NANNY_ALLOWED_EVENT_KEYS)', async () => {
      // Admin overrode `create_requests=true` for a nanny so the nanny
      // submitted a parent-request and is now the requesterUserId on the
      // request.accepted event. Without classification into nannyUserIds,
      // the policy filter would let them through. After H1 fix, they are
      // dropped silently.
      const w = wire();
      w.guardianRepo.setGuardiansForChild(CHILD, [
        approvedGuardian(USER_NANNY, 'nanny'),
      ]);
      w.tokenRepo.set(USER_NANNY, [
        { id: 'tn', userId: USER_NANNY, platform: 'ios', token: 'tok-n' },
      ]);
      const event = OutboxEvent.create(
        {
          id: '99999999-9999-9999-9999-99999999h111',
          kindergartenId: KG,
          eventKey: 'request.accepted',
          payload: {
            parentRequestId: 'pr-h1-1',
            childId: CHILD,
            requestType: 'absence',
            requesterUserId: USER_NANNY,
            reviewedByStaffId: 'staff-1',
          },
        },
        NOW,
      );

      const result = await w.dispatcher.dispatch(event);

      expect(result).toEqual({ status: 'dispatched' });
      // No history, no push, no WS — policy dropped the nanny.
      expect(w.notificationRepo.rows).toHaveLength(0);
      expect(w.pushPort.calls).toHaveLength(0);
      expect(w.ws.userBroadcasts).toHaveLength(0);
    });

    it('still delivers `request.rejected` to a parent requester (non-nanny)', async () => {
      const w = wire();
      w.guardianRepo.setGuardiansForChild(CHILD, [
        approvedGuardian(USER_A, 'primary'),
      ]);
      w.tokenRepo.set(USER_A, [
        { id: 'ta', userId: USER_A, platform: 'ios', token: 'tok-a' },
      ]);
      const event = OutboxEvent.create(
        {
          id: '99999999-9999-9999-9999-99999999h222',
          kindergartenId: KG,
          eventKey: 'request.rejected',
          payload: {
            parentRequestId: 'pr-h1-2',
            childId: CHILD,
            requestType: 'absence',
            requesterUserId: USER_A,
            reviewedByStaffId: 'staff-1',
          },
        },
        NOW,
      );

      const result = await w.dispatcher.dispatch(event);

      expect(result).toEqual({ status: 'dispatched' });
      expect(w.notificationRepo.rows.map((r) => r.userId)).toEqual([USER_A]);
    });

    it('drops a nanny requester from `request.message_sent` when staff replies (staff→requester branch)', async () => {
      const w = wire();
      w.guardianRepo.setGuardiansForChild(CHILD, [
        approvedGuardian(USER_NANNY, 'nanny'),
      ]);
      w.tokenRepo.set(USER_NANNY, [
        { id: 'tn2', userId: USER_NANNY, platform: 'android', token: 'tok-n' },
      ]);
      const event = OutboxEvent.create(
        {
          id: '99999999-9999-9999-9999-99999999h333',
          kindergartenId: KG,
          eventKey: 'request.message_sent',
          payload: {
            parentRequestId: 'pr-h1-3',
            childId: CHILD,
            messageId: 'm-1',
            authorRole: 'staff',
            requesterUserId: USER_NANNY,
          },
        },
        NOW,
      );

      const result = await w.dispatcher.dispatch(event);

      expect(result).toEqual({ status: 'dispatched' });
      expect(w.notificationRepo.rows).toHaveLength(0);
      expect(w.pushPort.calls).toHaveLength(0);
    });
  });

  // ── B13 Billing & Invoices nanny-policy ────────────────────────────────

  describe('billing nanny-policy filter', () => {
    it('excludes nanny guardians from invoice.paid recipients', async () => {
      const w = wire();
      w.guardianRepo.setGuardiansForChild(CHILD, [
        approvedGuardian(USER_A, 'primary'),
        approvedGuardian(USER_NANNY, 'nanny'),
      ]);
      w.tokenRepo.set(USER_A, [
        { id: 'ta', userId: USER_A, platform: 'ios', token: 'tok-a' },
      ]);
      w.tokenRepo.set(USER_NANNY, [
        { id: 'tn', userId: USER_NANNY, platform: 'android', token: 'tok-n' },
      ]);
      const event = OutboxEvent.create(
        {
          id: '99999999-9999-9999-9999-999999999b13',
          kindergartenId: KG,
          eventKey: 'invoice.paid',
          payload: {
            invoiceId: 'inv-1',
            childId: CHILD,
            amountAfterDiscount: 50000,
            paidAt: NOW.toISOString(),
          },
        },
        NOW,
      );

      const result = await w.dispatcher.dispatch(event);

      expect(result).toEqual({ status: 'dispatched' });
      // Nanny dropped — only USER_A receives the history row + push.
      expect(w.notificationRepo.rows.map((r) => r.userId)).toEqual([USER_A]);
      expect(w.pushPort.calls.map((c) => c.target.userId)).toEqual([USER_A]);
    });

    it('excludes nanny guardians from payment.completed recipients', async () => {
      const w = wire();
      w.guardianRepo.setGuardiansForChild(CHILD, [
        approvedGuardian(USER_A, 'primary'),
        approvedGuardian(USER_NANNY, 'nanny'),
      ]);
      const event = OutboxEvent.create(
        {
          id: '99999999-9999-9999-9999-999999999b14',
          kindergartenId: KG,
          eventKey: 'payment.completed',
          payload: {
            paymentId: 'pmt-1',
            invoiceId: 'inv-1',
            childId: CHILD,
            amount: 50000,
            provider: 'mock',
            paidAt: NOW.toISOString(),
          },
        },
        NOW,
      );

      const result = await w.dispatcher.dispatch(event);

      expect(result).toEqual({ status: 'dispatched' });
      expect(w.notificationRepo.rows.map((r) => r.userId)).toEqual([USER_A]);
    });

    it('excludes nanny guardians from refund.processed recipients', async () => {
      const w = wire();
      w.guardianRepo.setGuardiansForChild(CHILD, [
        approvedGuardian(USER_A, 'primary'),
        approvedGuardian(USER_NANNY, 'nanny'),
      ]);
      const event = OutboxEvent.create(
        {
          id: '99999999-9999-9999-9999-999999999b15',
          kindergartenId: KG,
          eventKey: 'refund.processed',
          payload: {
            refundId: 'r-1',
            paymentId: 'pmt-1',
            invoiceId: 'inv-1',
            childId: CHILD,
            amount: 50000,
            processedBy: USER_A,
          },
        },
        NOW,
      );

      const result = await w.dispatcher.dispatch(event);

      expect(result).toEqual({ status: 'dispatched' });
      expect(w.notificationRepo.rows.map((r) => r.userId)).toEqual([USER_A]);
    });
  });

  // ── coverage assertion (HIGH#1 guardrail) ──────────────────────────────

  describe('dispatcher event-key coverage', () => {
    // Subset of CANONICAL_EVENT_KEYS that the dispatcher MUST be able to
    // handle today. As B-batches grow this list (payment, content,
    // diagnostic, fiscal, …), extend the array — the test fails until both
    // a template and a resolver are wired, so a future B-batch cannot add
    // an event key without updating the dispatcher.
    const COVERED_KEYS = [
      'attendance.checkin',
      'attendance.checkout',
      'daily_status.changed',
      'timeline.entry_created',
      'guardian.approved',
      'guardian.self_revoked',
      'guardian.pending_approval',
      'guardian.rejected',
      'guardian.revoked',
      'guardian.permissions_updated',
      'child.transferred',
      // ── B11 Pickup OTP ─────────────────────────────────────────────────
      'pickup.otp_sent',
      'pickup.validated',
      // ── B12 Parent-request lifecycle ───────────────────────────────────
      'request.accepted',
      'request.rejected',
      'request.cancelled',
      'request.message_sent',
      // ── B13 Billing & Invoices ─────────────────────────────────────────
      'invoice.created',
      'invoice.paid',
      'invoice.overdue',
      'invoice.cancelled',
      'payment.completed',
      'payment.failed',
      'payment.refunded',
      'refund.processed',
    ];

    it.each(COVERED_KEYS)(
      'has a template + resolver wired for %s',
      (eventKey) => {
        expect(EVENT_TEMPLATES[eventKey]).toBeDefined();
        expect(EVENT_RECIPIENT_RESOLVERS[eventKey]).toBeDefined();
      },
    );
  });

  // ── HIGH#2 SavepointRollback contract ──────────────────────────────────

  describe('SavepointRollback', () => {
    it('exports a sentinel error with the failure reason as message', () => {
      const err = new SavepointRollback('push_transient_failures=2');
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('SavepointRollback');
      expect(err.message).toBe('push_transient_failures=2');
    });
  });
});

// ── push-error classifier ────────────────────────────────────────────────

describe('classifyPushError', () => {
  it.each([
    ['NotRegistered', 'permanent_token'],
    ['InvalidRegistration', 'permanent_token'],
    ['BadDeviceToken', 'permanent_token'],
    ['Unregistered', 'permanent_token'],
    ['MismatchSenderId', 'permanent_token'],
    ['messaging/registration-token-not-registered', 'permanent_token'],
    ['messaging/invalid-registration-token', 'permanent_token'],
    ['DeviceTokenNotForTopic', 'permanent_token'],
  ])('classifies "%s" as %s', (msg, expected) => {
    expect(classifyPushError(new Error(msg))).toBe(expected);
  });

  it('reads the FCM-style `code` field, not just message', () => {
    const err = Object.assign(new Error('something happened'), {
      code: 'messaging/registration-token-not-registered',
    });
    expect(classifyPushError(err)).toBe('permanent_token');
  });

  it.each([
    'connect ETIMEDOUT',
    'fcm_500',
    'service unavailable',
    'Internal server error',
    'QuotaExceeded',
    '',
  ])('classifies "%s" as transient', (msg) => {
    expect(classifyPushError(new Error(msg))).toBe('transient');
  });

  it('classifies non-Error throws as transient (last-resort safety)', () => {
    expect(classifyPushError('boom')).toBe('transient');
    expect(classifyPushError(null)).toBe('transient');
    expect(classifyPushError(undefined)).toBe('transient');
    expect(classifyPushError({ weird: true })).toBe('transient');
  });
});
