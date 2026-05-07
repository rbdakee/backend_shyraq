import { DataSource } from 'typeorm';
import {
  AttendanceCheckInEvent,
  AttendanceCheckOutEvent,
  ChildTransferredEvent,
  DailyStatusChangedEvent,
  GuardianApprovedEvent,
  GuardianPendingApprovalEvent,
  GuardianRejectedEvent,
  GuardianRevokedEvent,
  GuardianSelfRevokedEvent,
  NotificationPort,
  NotifyContentBirthdayInput,
  NotifyEnrollmentFirstInvoiceSkippedInput,
  NotifyInvoiceCancelledInput,
  NotifyInvoiceCreatedInput,
  NotifyInvoiceOverdueInput,
  NotifyInvoicePaidInput,
  NotifyPaymentCompletedInput,
  NotifyPaymentFailedInput,
  NotifyPaymentRefundedInput,
  NotifyRefundProcessedInput,
  ParentRequestAcceptedEvent,
  ParentRequestCancelledEvent,
  ParentRequestMessageSentEvent,
  ParentRequestRejectedEvent,
  PermissionsUpdatedEvent,
  PickupOtpSentEvent,
  PickupValidatedEvent,
  TimelineEntryCreatedEvent,
} from '@/common/notifications/notification.port';
import { Child } from '@/modules/child/domain/entities/child.entity';
import {
  ChildGroupHistoryRecord,
  ChildListFilters,
  ChildRepository,
  PageRequest,
  PageResult,
} from '@/modules/child/infrastructure/persistence/child.repository';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { BirthdayGeneratorService } from './birthday-generator.service';
import {
  ContentRepository,
  ListContentFilters,
  TransitionStatusPatch,
} from './content.repository';
import {
  ContentPost,
  ContentStatus,
} from './domain/entities/content-post.entity';

const KG = '11111111-1111-1111-1111-111111111111';
const NOW = new Date('2026-05-07T07:00:00.000Z');

class FakeClock extends ClockPort {
  now(): Date {
    return NOW;
  }
}

class FakeContentRepo extends ContentRepository {
  posts: ContentPost[] = [];
  existsById = new Set<string>();
  create(p: ContentPost): Promise<ContentPost> {
    this.posts.push(p);
    return Promise.resolve(p);
  }
  update(p: ContentPost): Promise<ContentPost> {
    return Promise.resolve(p);
  }
  delete(): Promise<boolean> {
    return Promise.resolve(true);
  }
  findById(): Promise<ContentPost | null> {
    return Promise.resolve(null);
  }
  list(_kg: string, _f: ListContentFilters): Promise<ContentPost[]> {
    return Promise.resolve([]);
  }
  transitionStatus(
    _kg: string,
    _id: string,
    _expected: ContentStatus,
    _next: ContentStatus,
    _patch: TransitionStatusPatch,
  ): Promise<ContentPost | null> {
    return Promise.resolve(null);
  }
  listScheduledDue(): Promise<ContentPost[]> {
    return Promise.resolve([]);
  }
  existsBirthdayForChildOnDate(
    _kg: string,
    childId: string,
    _date: Date,
  ): Promise<boolean> {
    return Promise.resolve(this.existsById.has(childId));
  }
}

function makeChild(id: string, dob: Date, fullName = 'Test'): Child {
  return {
    toState: () => ({
      id,
      kindergartenId: KG,
      fullName,
      dateOfBirth: dob,
      currentGroupId: null,
      status: 'active',
    }),
  } as unknown as Child;
}

class FakeChildRepo extends ChildRepository {
  byMonthDay = new Map<string, Child[]>();
  create(): Promise<void> {
    return Promise.resolve();
  }
  findById(): Promise<Child | null> {
    return Promise.resolve(null);
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
  listActiveByBirthdayMonthDay(
    _kg: string,
    month: number,
    day: number,
  ): Promise<Child[]> {
    return Promise.resolve(this.byMonthDay.get(`${month}-${day}`) ?? []);
  }
}

class FakeNotificationPort extends NotificationPort {
  birthdays: NotifyContentBirthdayInput[] = [];
  notifyGuardianPendingApproval(_e: GuardianPendingApprovalEvent) {
    return Promise.resolve();
  }
  notifyGuardianApproved(_e: GuardianApprovedEvent) {
    return Promise.resolve();
  }
  notifyGuardianRejected(_e: GuardianRejectedEvent) {
    return Promise.resolve();
  }
  notifyGuardianRevoked(_e: GuardianRevokedEvent) {
    return Promise.resolve();
  }
  notifyChildTransferred(_e: ChildTransferredEvent) {
    return Promise.resolve();
  }
  notifyPermissionsUpdated(_e: PermissionsUpdatedEvent) {
    return Promise.resolve();
  }
  notifyAttendanceCheckIn(_e: AttendanceCheckInEvent) {
    return Promise.resolve();
  }
  notifyAttendanceCheckOut(_e: AttendanceCheckOutEvent) {
    return Promise.resolve();
  }
  notifyDailyStatusChanged(_e: DailyStatusChangedEvent) {
    return Promise.resolve();
  }
  notifyTimelineEntryCreated(_e: TimelineEntryCreatedEvent) {
    return Promise.resolve();
  }
  notifyGuardianSelfRevoked(_e: GuardianSelfRevokedEvent) {
    return Promise.resolve();
  }
  notifyPickupOtpSent(_e: PickupOtpSentEvent) {
    return Promise.resolve();
  }
  notifyPickupValidated(_e: PickupValidatedEvent) {
    return Promise.resolve();
  }
  notifyParentRequestAccepted(_e: ParentRequestAcceptedEvent) {
    return Promise.resolve();
  }
  notifyParentRequestRejected(_e: ParentRequestRejectedEvent) {
    return Promise.resolve();
  }
  notifyParentRequestCancelled(_e: ParentRequestCancelledEvent) {
    return Promise.resolve();
  }
  notifyParentRequestMessageSent(_e: ParentRequestMessageSentEvent) {
    return Promise.resolve();
  }
  notifyInvoiceCreated(_e: NotifyInvoiceCreatedInput) {
    return Promise.resolve();
  }
  notifyInvoicePaid(_e: NotifyInvoicePaidInput) {
    return Promise.resolve();
  }
  notifyInvoiceOverdue(_e: NotifyInvoiceOverdueInput) {
    return Promise.resolve();
  }
  notifyInvoiceCancelled(_e: NotifyInvoiceCancelledInput) {
    return Promise.resolve();
  }
  notifyPaymentCompleted(_e: NotifyPaymentCompletedInput) {
    return Promise.resolve();
  }
  notifyPaymentFailed(_e: NotifyPaymentFailedInput) {
    return Promise.resolve();
  }
  notifyPaymentRefunded(_e: NotifyPaymentRefundedInput) {
    return Promise.resolve();
  }
  notifyRefundProcessed(_e: NotifyRefundProcessedInput) {
    return Promise.resolve();
  }
  notifyEnrollmentFirstInvoiceSkipped(
    _e: NotifyEnrollmentFirstInvoiceSkippedInput,
  ) {
    return Promise.resolve();
  }
  notifyContentBirthday(e: NotifyContentBirthdayInput) {
    this.birthdays.push(e);
    return Promise.resolve();
  }
}

const fakeDataSource = {
  transaction: async <T>(cb: (em: unknown) => Promise<T>): Promise<T> =>
    cb({ query: () => Promise.resolve(undefined) }),
} as unknown as DataSource;

function buildService() {
  const contentRepo = new FakeContentRepo();
  const childRepo = new FakeChildRepo();
  const notification = new FakeNotificationPort();
  const service = new BirthdayGeneratorService(
    contentRepo,
    childRepo,
    notification,
    fakeDataSource,
    new FakeClock(),
  );
  return { service, contentRepo, childRepo, notification };
}

describe('BirthdayGeneratorService.runDaily', () => {
  it('returns 0/0 when no children match today', async () => {
    const { service } = buildService();
    const r = await service.runDaily(KG, NOW);
    expect(r).toEqual({ generatedCount: 0, skippedCount: 0 });
  });

  it('generates a birthday post for one matching child', async () => {
    const { service, childRepo, contentRepo, notification } = buildService();
    const child = makeChild(
      'child-1',
      new Date('2020-05-07T00:00:00.000Z'),
      'Almas',
    );
    childRepo.byMonthDay.set('5-7', [child]);
    const r = await service.runDaily(KG, NOW);
    expect(r.generatedCount).toBe(1);
    expect(r.skippedCount).toBe(0);
    expect(contentRepo.posts).toHaveLength(1);
    expect(contentRepo.posts[0].targetChildId).toBe('child-1');
    expect(contentRepo.posts[0].contentType).toBe('birthday');
    expect(notification.birthdays).toHaveLength(1);
    expect(notification.birthdays[0].childFullName).toBe('Almas');
  });

  it('skips when birthday already exists (idempotency)', async () => {
    const { service, childRepo, contentRepo } = buildService();
    const child = makeChild('child-1', new Date('2020-05-07T00:00:00.000Z'));
    childRepo.byMonthDay.set('5-7', [child]);
    contentRepo.existsById.add('child-1');
    const r = await service.runDaily(KG, NOW);
    expect(r.generatedCount).toBe(0);
    expect(r.skippedCount).toBe(1);
    expect(contentRepo.posts).toHaveLength(0);
  });

  it('computes age = today.year - dob.year (after birth-month-day)', async () => {
    const { service, childRepo, notification } = buildService();
    const child = makeChild('child-1', new Date('2020-05-07T00:00:00.000Z'));
    childRepo.byMonthDay.set('5-7', [child]);
    await service.runDaily(KG, NOW);
    // 2026 - 2020 = 6
    expect(notification.birthdays[0].age).toBe(6);
  });

  it('handles Feb 29 leap-year policy: Feb-28 in non-leap year picks up Feb-29 children', async () => {
    const { service, childRepo, notification } = buildService();
    // 2026 is not a leap year. today=Feb-28, 2026.
    const today = new Date('2026-02-28T07:00:00.000Z');
    const childFeb29 = makeChild(
      'leap-child',
      new Date('2020-02-29T00:00:00.000Z'),
      'Aru',
    );
    childRepo.byMonthDay.set('2-28', []);
    childRepo.byMonthDay.set('2-29', [childFeb29]);
    const r = await service.runDaily(KG, today);
    expect(r.generatedCount).toBe(1);
    expect(notification.birthdays[0].targetChildId).toBe('leap-child');
  });

  it('does NOT pull Feb-29 set when today=Feb-29 in a leap year', async () => {
    const { service, childRepo } = buildService();
    const today = new Date('2024-02-29T07:00:00.000Z'); // 2024 is a leap year
    const child = makeChild('child-1', new Date('2020-02-29T00:00:00.000Z'));
    childRepo.byMonthDay.set('2-29', [child]);
    const r = await service.runDaily(KG, today);
    // Just one — primary set already includes Feb-29; no double-emit.
    expect(r.generatedCount).toBe(1);
  });

  it('continues across multiple children even when one fails', async () => {
    const { service, childRepo, contentRepo } = buildService();
    const c1 = makeChild('c1', new Date('2020-05-07T00:00:00.000Z'));
    const c2 = makeChild('c2', new Date('2020-05-07T00:00:00.000Z'));
    childRepo.byMonthDay.set('5-7', [c1, c2]);
    let n = 0;
    const origCreate = contentRepo.create.bind(contentRepo);
    contentRepo.create = (p: ContentPost) => {
      n += 1;
      if (n === 1) return Promise.reject(new Error('boom'));
      return origCreate(p);
    };
    const r = await service.runDaily(KG, NOW);
    expect(r.generatedCount).toBe(1);
  });
});
