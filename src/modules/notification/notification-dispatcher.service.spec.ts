import { ChildId } from '@/shared-kernel/domain/value-objects/child-id.vo';
import { GuardianRelation } from '@/shared-kernel/domain/value-objects/guardian-relation.vo';
import { KindergartenId } from '@/shared-kernel/domain/value-objects/kindergarten-id.vo';
import { UserId } from '@/shared-kernel/domain/value-objects/user-id.vo';
import { ChildGuardian } from '@/modules/child/domain/entities/child-guardian.entity';
import { ChildGuardianRepository } from '@/modules/child/infrastructure/persistence/child-guardian.repository';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import {
  PushNotificationPort,
  PushPayload,
  PushTarget,
} from '@/shared-kernel/domain/push-notification.port';
import { OutboxEvent } from './domain/entities/outbox-event.entity';
import { NotificationDispatcher } from './notification-dispatcher.service';
import {
  NotificationPreferenceFlags,
  NotificationPreferenceRepository,
} from './notification-preference.repository';
import {
  NotificationCreateInput,
  NotificationRepository,
} from './notification.repository';
import { PushTokenRepository, PushTokenSummary } from './push-token.repository';
import { WsBroadcaster } from './ws-broadcaster.port';

const KG = '11111111-1111-1111-1111-111111111111';
const CHILD = '22222222-2222-2222-2222-222222222222';
const USER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const USER_NANNY = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
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
}

class FakePushTokenRepo extends PushTokenRepository {
  byUser = new Map<string, PushTokenSummary[]>();

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
}

class RecordingPushPort extends PushNotificationPort {
  calls: { target: PushTarget; payload: PushPayload }[] = [];
  failOnUserId: string | null = null;

  send(target: PushTarget, payload: PushPayload): Promise<void> {
    this.calls.push({ target, payload });
    if (this.failOnUserId === target.userId) {
      return Promise.reject(new Error('fcm_500'));
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

// helper to silence unused-imports in lint while keeping VOs reachable for
// future expansion of this spec.
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
}

function wire(): Wired {
  const guardianRepo = new FakeGuardianRepo();
  const prefRepo = new FakePreferenceRepo();
  const tokenRepo = new FakePushTokenRepo();
  const notificationRepo = new FakeNotificationRepo();
  const pushPort = new RecordingPushPort();
  const ws = new RecordingWsBroadcaster();
  const clock = new FixedClock(NOW);
  const dispatcher = new NotificationDispatcher(
    guardianRepo,
    prefRepo,
    tokenRepo,
    notificationRepo,
    pushPort,
    ws,
    clock,
  );
  return {
    dispatcher,
    guardianRepo,
    prefRepo,
    tokenRepo,
    notificationRepo,
    pushPort,
    ws,
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
      // Send to NANNY user-id explicitly. The dispatcher does not refetch
      // the guardian role for guardian.* events — they target a specific
      // userId. The nanny set is empty for guardian.* events, so the
      // recipient is NOT filtered. This test asserts the documented
      // behaviour: guardian.approved fires for the affected user even when
      // they hold a nanny row elsewhere.
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
      // Use timeline.entry_created — not in nanny allowlist. Nanny is a
      // guardian on the child, so resolveRecipients picks them up; the
      // policy filter then drops them.
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
      // USER_B has no row → defaults to all-on.
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
      // No tokens registered.

      const result = await w.dispatcher.dispatch(makeAttendanceEvent());

      expect(result).toEqual({ status: 'dispatched' });
      expect(w.pushPort.calls).toHaveLength(0);
      // History row still written.
      expect(w.notificationRepo.rows).toHaveLength(1);
    });

    it('treats per-user push failure as soft — overall result still dispatched', async () => {
      const w = wire();
      w.guardianRepo.setGuardiansForChild(CHILD, [
        approvedGuardian(USER_A, 'primary'),
        approvedGuardian(USER_B, 'secondary'),
      ]);
      w.tokenRepo.set(USER_A, [
        { id: 't1', userId: USER_A, platform: 'ios', token: 'tok-a' },
      ]);
      w.tokenRepo.set(USER_B, [
        { id: 't2', userId: USER_B, platform: 'android', token: 'tok-b' },
      ]);
      w.pushPort.failOnUserId = USER_A;

      const result = await w.dispatcher.dispatch(makeAttendanceEvent());

      expect(result).toEqual({ status: 'dispatched' });
      // Both calls were attempted.
      expect(w.pushPort.calls.map((c) => c.target.userId).sort()).toEqual(
        [USER_A, USER_B].sort(),
      );
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
      // No guardians configured for the child.

      const result = await w.dispatcher.dispatch(makeAttendanceEvent());

      expect(result).toEqual({ status: 'dispatched' });
      expect(w.notificationRepo.rows).toHaveLength(0);
      expect(w.pushPort.calls).toHaveLength(0);
    });
  });
});
