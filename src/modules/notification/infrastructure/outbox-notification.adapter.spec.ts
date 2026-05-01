import { EntityManager } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import {
  EnqueueOutboxEventInput,
  OutboxEventRepository,
} from '../outbox-event.repository';
import { OutboxEvent } from '../domain/entities/outbox-event.entity';
import { OutboxNotificationAdapter } from './outbox-notification.adapter';

const KG = '11111111-1111-1111-1111-111111111111';
const CHILD = '22222222-2222-2222-2222-222222222222';
const USER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const NOW = new Date('2026-05-01T09:00:00.000Z');

class FakeOutboxRepo extends OutboxEventRepository {
  calls: {
    input: EnqueueOutboxEventInput;
    manager: EntityManager | undefined;
  }[] = [];

  enqueue(
    input: EnqueueOutboxEventInput,
    manager?: EntityManager,
  ): Promise<OutboxEvent> {
    this.calls.push({ input, manager });
    return Promise.resolve(
      OutboxEvent.create(
        {
          id: '99999999-9999-9999-9999-999999999999',
          kindergartenId: input.kindergartenId,
          eventKey: input.eventKey,
          payload: input.payload,
        },
        NOW,
      ),
    );
  }
  claimBatch(): Promise<OutboxEvent[]> {
    return Promise.resolve([]);
  }
  markDispatched(): Promise<void> {
    return Promise.resolve();
  }
  markFailedWithRetry(): Promise<void> {
    return Promise.resolve();
  }
  findById(): Promise<OutboxEvent | null> {
    return Promise.resolve(null);
  }
}

describe('OutboxNotificationAdapter', () => {
  let repo: FakeOutboxRepo;
  let adapter: OutboxNotificationAdapter;

  beforeEach(() => {
    repo = new FakeOutboxRepo();
    adapter = new OutboxNotificationAdapter(repo);
  });

  it('enqueues attendance.checkin with serialised payload', async () => {
    await adapter.notifyAttendanceCheckIn({
      kindergartenId: KG,
      childId: CHILD,
      eventId: 'evt-1',
      recordedAt: NOW,
      recordedByStaffMemberId: 'staff-1',
    });

    expect(repo.calls).toHaveLength(1);
    expect(repo.calls[0].input).toEqual({
      kindergartenId: KG,
      eventKey: 'attendance.checkin',
      payload: {
        childId: CHILD,
        eventId: 'evt-1',
        recordedAt: NOW.toISOString(),
        recordedByStaffMemberId: 'staff-1',
      },
    });
  });

  it('enqueues attendance.checkout with pickup fields', async () => {
    await adapter.notifyAttendanceCheckOut({
      kindergartenId: KG,
      childId: CHILD,
      eventId: 'evt-2',
      recordedAt: NOW,
      recordedByStaffMemberId: null,
      pickupUserId: USER,
      pickupRequestId: null,
    });

    expect(repo.calls).toHaveLength(1);
    expect(repo.calls[0].input.eventKey).toBe('attendance.checkout');
    expect(repo.calls[0].input.payload).toMatchObject({
      childId: CHILD,
      eventId: 'evt-2',
      pickupUserId: USER,
      pickupRequestId: null,
    });
  });

  it('enqueues daily_status.changed', async () => {
    await adapter.notifyDailyStatusChanged({
      kindergartenId: KG,
      childId: CHILD,
      date: '2026-05-01',
      status: 'sick',
      setByStaffMemberId: null,
    });

    expect(repo.calls[0].input.eventKey).toBe('daily_status.changed');
    expect(repo.calls[0].input.payload).toEqual({
      childId: CHILD,
      date: '2026-05-01',
      status: 'sick',
      setByStaffMemberId: null,
    });
  });

  it('enqueues timeline.entry_created', async () => {
    await adapter.notifyTimelineEntryCreated({
      kindergartenId: KG,
      childId: CHILD,
      entryId: 'tl-1',
      entryType: 'progress_note',
      entryTime: NOW,
      recordedByStaffMemberId: null,
    });

    expect(repo.calls[0].input.eventKey).toBe('timeline.entry_created');
    expect(repo.calls[0].input.payload).toMatchObject({
      childId: CHILD,
      entryId: 'tl-1',
      entryType: 'progress_note',
      entryTime: NOW.toISOString(),
    });
  });

  it('enqueues guardian.approved', async () => {
    await adapter.notifyGuardianApproved({
      kindergartenId: KG,
      childId: CHILD,
      guardianUserId: USER,
      approvedBy: USER,
      hasApprovalRights: true,
    });

    expect(repo.calls[0].input.eventKey).toBe('guardian.approved');
    expect(repo.calls[0].input.payload).toEqual({
      childId: CHILD,
      guardianUserId: USER,
      approvedBy: USER,
      hasApprovalRights: true,
    });
  });

  it('enqueues guardian.self_revoked', async () => {
    await adapter.notifyGuardianSelfRevoked({
      kindergartenId: KG,
      childId: CHILD,
      userId: USER,
      revokedAt: NOW,
    });

    expect(repo.calls[0].input.eventKey).toBe('guardian.self_revoked');
    expect(repo.calls[0].input.payload).toEqual({
      childId: CHILD,
      userId: USER,
      revokedAt: NOW.toISOString(),
    });
  });

  it('forwards manager from tenantStorage when running inside a tenant TX', async () => {
    const fakeManager = { __mark: 'fake-manager' } as unknown as EntityManager;
    await tenantStorage.run(
      {
        kgId: KG,
        bypass: false,
        entityManager: fakeManager,
      },
      async () => {
        await adapter.notifyAttendanceCheckIn({
          kindergartenId: KG,
          childId: CHILD,
          eventId: 'evt-tx',
          recordedAt: NOW,
          recordedByStaffMemberId: null,
        });
      },
    );

    expect(repo.calls).toHaveLength(1);
    expect(repo.calls[0].manager).toBe(fakeManager);
  });

  it('passes manager=undefined when no tenant TX is active', async () => {
    await adapter.notifyAttendanceCheckIn({
      kindergartenId: KG,
      childId: CHILD,
      eventId: 'evt-no-tx',
      recordedAt: NOW,
      recordedByStaffMemberId: null,
    });

    expect(repo.calls).toHaveLength(1);
    expect(repo.calls[0].manager).toBeUndefined();
  });
});
