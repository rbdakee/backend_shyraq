import { DataSource } from 'typeorm';
import { Job } from 'bullmq';
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
  NotifyContentNewsPublishedInput,
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
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import {
  ContentRepository,
  ListContentFilters,
  TransitionStatusPatch,
} from '../content.repository';
import {
  ContentPost,
  ContentStatus,
} from '../domain/entities/content-post.entity';
import {
  CONTENT_PUBLISH_RECURRING_JOB,
  ContentPublishJobData,
  ContentPublishProcessor,
} from './content-publish.processor';

const KG = '11111111-1111-1111-1111-111111111111';
const NOW = new Date('2026-05-12T07:00:00.000Z');

class FakeClock extends ClockPort {
  now(): Date {
    return NOW;
  }
}

/**
 * B22a T5 — fake EntityManager whose nested `transaction(...)` call
 * simulates `SAVEPOINT`/`ROLLBACK TO SAVEPOINT` semantics: the inner
 * callback runs inline; if it throws, the throw propagates (mirrors
 * `ROLLBACK TO SAVEPOINT`) but the outer manager remains usable so the
 * per-post loop in the kg-batch can move to the next post.
 *
 * Mirrors the helper in `birthday-generator.service.spec.ts` so per-post
 * SAVEPOINT regressions in either processor are testable without a live
 * Postgres.
 */
function buildFakeManager(): unknown {
  const m: { query: () => Promise<unknown>; transaction: unknown } = {
    query: () => Promise.resolve(undefined),
    transaction: undefined,
  };
  m.transaction = async <T>(
    cb: (savepoint: unknown) => Promise<T>,
  ): Promise<T> => cb(buildFakeManager());
  return m;
}

class FakeContentRepo extends ContentRepository {
  /** kg-bypass listing: rows we expose to `listAllKindergartens`. */
  posts: ContentPost[] = [];
  /** Failure-injection — postIds whose `transitionStatus` should reject. */
  failTransitionFor = new Set<string>();
  /** Failure-injection — postIds whose `transitionStatus` returns null
   * (mirrors a concurrent flip / status changed underneath us). */
  missTransitionFor = new Set<string>();
  transitionedTo = new Map<string, ContentStatus>();

  create(p: ContentPost): Promise<ContentPost> {
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
    id: string,
    _expected: ContentStatus,
    next: ContentStatus,
    patch: TransitionStatusPatch,
  ): Promise<ContentPost | null> {
    if (this.failTransitionFor.has(id)) {
      return Promise.reject(new Error('outbox_insert_boom'));
    }
    if (this.missTransitionFor.has(id)) {
      return Promise.resolve(null);
    }
    const idx = this.posts.findIndex((p) => p.id === id);
    if (idx < 0) return Promise.resolve(null);
    const current = this.posts[idx];
    const updated = ContentPost.fromState({
      ...current.toState(),
      status: next,
      publishedAt: patch.publishedAt ?? current.publishedAt,
      updatedAt: patch.updatedAt,
    });
    this.posts[idx] = updated;
    this.transitionedTo.set(id, next);
    return Promise.resolve(updated);
  }
  listScheduledDue(
    _kg: string,
    _now: Date,
    _limit: number,
  ): Promise<ContentPost[]> {
    return Promise.resolve(this.posts.filter((p) => p.status === 'scheduled'));
  }
  existsBirthdayForChildOnDate(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

class FakeNotificationPort extends NotificationPort {
  newsEmitted: NotifyContentNewsPublishedInput[] = [];
  birthdayEmitted: NotifyContentBirthdayInput[] = [];
  /** Inject a failure on news emit for a specific contentPostId. */
  failNewsFor = new Set<string>();

  // ── B17 content (overridden) ─────────────────────────────────────
  notifyContentNewsPublished(
    e: NotifyContentNewsPublishedInput,
  ): Promise<void> {
    if (this.failNewsFor.has(e.contentPostId)) {
      return Promise.reject(new Error('outbox_insert_boom'));
    }
    this.newsEmitted.push(e);
    return Promise.resolve();
  }
  notifyContentBirthday(e: NotifyContentBirthdayInput): Promise<void> {
    this.birthdayEmitted.push(e);
    return Promise.resolve();
  }

  // ── abstract no-op stubs (unused in this spec) ────────────────────
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
}

function makeScheduledNewsPost(id: string): ContentPost {
  return ContentPost.fromState({
    id,
    kindergartenId: KG,
    contentType: 'news',
    targetType: 'all',
    targetGroupId: null,
    targetChildId: null,
    title: null,
    body: null,
    titleI18n: { ru: `Title ${id}`, kk: `Атауы ${id}` },
    bodyI18n: { ru: `Body ${id}`, kk: `Мәтіні ${id}` },
    mediaUrls: null,
    metadata: null,
    scheduledFor: new Date('2026-05-12T06:00:00.000Z'),
    publishedAt: null,
    expiresAt: null,
    status: 'scheduled',
    createdBy: null,
    createdAt: new Date('2026-05-11T00:00:00.000Z'),
    updatedAt: new Date('2026-05-11T00:00:00.000Z'),
  });
}

/**
 * B22a T5 — DataSource fake whose top-level `transaction` returns the
 * `buildFakeManager()` EM (which itself supports nested `transaction(...)`
 * for SAVEPOINT semantics). The processor's `runForKindergarten` opens
 * the outer kg-batch TX via `dataSource.transaction(em => …)` and then
 * the per-post savepoint via `em.transaction(savepointManager => …)` —
 * both are honored by this fake.
 */
const fakeDataSource = {
  transaction: async <T>(cb: (em: unknown) => Promise<T>): Promise<T> =>
    cb(buildFakeManager()),
} as unknown as DataSource;

function buildProcessor() {
  const contentRepo = new FakeContentRepo();
  const notification = new FakeNotificationPort();
  const processor = new ContentPublishProcessor(
    contentRepo,
    notification,
    fakeDataSource,
    new FakeClock(),
  );
  // listAllKindergartens does its own dataSource.transaction → bypass_rls
  // raw-SQL path. Bypass it by overriding through the prototype-private
  // accessor: replace the method directly on the instance.
  (
    processor as unknown as { listAllKindergartens: () => Promise<string[]> }
  ).listAllKindergartens = () => Promise.resolve([KG]);
  return { processor, contentRepo, notification };
}

function makeJob(): Job<ContentPublishJobData> {
  return {
    name: CONTENT_PUBLISH_RECURRING_JOB,
    data: {},
  } as unknown as Job<ContentPublishJobData>;
}

describe('ContentPublishProcessor.process', () => {
  it('publishes all 4 scheduled posts when none fail', async () => {
    const { processor, contentRepo, notification } = buildProcessor();
    contentRepo.posts = [
      makeScheduledNewsPost('p0'),
      makeScheduledNewsPost('p1'),
      makeScheduledNewsPost('p2'),
      makeScheduledNewsPost('p3'),
    ];

    const summary = await processor.process(makeJob());

    expect(summary.publishedCount).toBe(4);
    expect(summary.skippedCount).toBe(0);
    expect(summary.errors).toBe(0);
    expect(contentRepo.posts.every((p) => p.status === 'published')).toBe(true);
    expect(notification.newsEmitted.map((e) => e.contentPostId)).toEqual([
      'p0',
      'p1',
      'p2',
      'p3',
    ]);
  });

  it('isolates per-post failure via SAVEPOINT — posts[0,2,3] still published when post[1] transition throws', async () => {
    const { processor, contentRepo, notification } = buildProcessor();
    contentRepo.posts = [
      makeScheduledNewsPost('p0'),
      makeScheduledNewsPost('p1'),
      makeScheduledNewsPost('p2'),
      makeScheduledNewsPost('p3'),
    ];
    // Inject failure on the conditional UPDATE itself (mirrors a
    // DB-level error inside the savepoint — could be a serialization
    // failure, a CHECK violation, or a downstream outbox INSERT throw).
    contentRepo.failTransitionFor.add('p1');

    const summary = await processor.process(makeJob());

    expect(summary.publishedCount).toBe(3);
    expect(summary.skippedCount).toBe(1);
    expect(summary.errors).toBe(0);
    // Posts 0,2,3 flipped to published; post 1 stayed scheduled (its
    // savepoint rolled back, but the outer kg-batch TX survived so the
    // loop continued processing the remaining posts).
    expect(contentRepo.transitionedTo.get('p0')).toBe('published');
    expect(contentRepo.transitionedTo.get('p1')).toBeUndefined();
    expect(contentRepo.transitionedTo.get('p2')).toBe('published');
    expect(contentRepo.transitionedTo.get('p3')).toBe('published');
    expect(notification.newsEmitted.map((e) => e.contentPostId)).toEqual([
      'p0',
      'p2',
      'p3',
    ]);
  });

  it('skips a post whose conditional transitionStatus matches 0 rows (concurrent flip)', async () => {
    const { processor, contentRepo, notification } = buildProcessor();
    contentRepo.posts = [
      makeScheduledNewsPost('p0'),
      makeScheduledNewsPost('p1'),
    ];
    contentRepo.missTransitionFor.add('p1');

    const summary = await processor.process(makeJob());

    expect(summary.publishedCount).toBe(1);
    expect(summary.skippedCount).toBe(1);
    expect(notification.newsEmitted.map((e) => e.contentPostId)).toEqual([
      'p0',
    ]);
  });
});
