import type { EntityManager } from '@/shared-kernel/application/ports/transaction-runner.port';
import { TransactionRunnerPort } from '@/shared-kernel/application/ports/transaction-runner.port';
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
  NotifyContentQundylyqNewInput,
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
import { Group } from '@/modules/group/domain/entities/group.entity';
import { GroupMentor } from '@/modules/group/domain/entities/group-mentor.entity';
import {
  CreateGroupInput,
  GroupRepository,
  ListGroupsFilters,
  UpdateGroupInput,
} from '@/modules/group/infrastructure/persistence/group.repository';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import {
  FileStoragePort,
  FileStorageUploadInput,
  FileStorageUploadResult,
} from '@/shared-kernel/storage/file-storage.port';
import { ContentService } from './content.service';
import {
  ContentRepository,
  ListContentFilters,
  TransitionStatusPatch,
} from './content.repository';
import {
  ContentPost,
  ContentStatus,
} from './domain/entities/content-post.entity';
import { ContentPostNotFoundError } from './domain/errors/content-post-not-found.error';
import { ContentPostStatusInvalidError } from './domain/errors/content-post-status-invalid.error';
import { FileUploadError } from './domain/errors/file-upload.error';
import { MediaTypeInvalidError } from './domain/errors/media-type-invalid.error';
import { ChildNotFoundError } from '@/modules/child/domain/errors/child-not-found.error';
import { GroupNotFoundError } from '@/modules/group/domain/errors/group-not-found.error';

const KG = '11111111-1111-1111-1111-111111111111';
const KG_OTHER = '22222222-2222-2222-2222-222222222222';
const GROUP = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CHILD = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const USER = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const NOW = new Date('2026-05-07T12:00:00.000Z');
const FUTURE = new Date('2026-05-08T12:00:00.000Z');

class FakeClock extends ClockPort {
  constructor(private current: Date = NOW) {
    super();
  }
  now(): Date {
    return this.current;
  }
  set(d: Date): void {
    this.current = d;
  }
}

class FakeContentRepo extends ContentRepository {
  private posts = new Map<string, ContentPost>();
  createCalls = 0;
  transitionCalls: Array<{
    id: string;
    expected: ContentStatus;
    next: ContentStatus;
  }> = [];

  create(post: ContentPost): Promise<ContentPost> {
    this.posts.set(post.id, post);
    this.createCalls += 1;
    return Promise.resolve(post);
  }
  update(post: ContentPost): Promise<ContentPost> {
    this.posts.set(post.id, post);
    return Promise.resolve(post);
  }
  delete(_kg: string, id: string): Promise<boolean> {
    const had = this.posts.delete(id);
    return Promise.resolve(had);
  }
  findById(_kg: string, id: string): Promise<ContentPost | null> {
    return Promise.resolve(this.posts.get(id) ?? null);
  }
  list(_kg: string, _filters: ListContentFilters): Promise<ContentPost[]> {
    return Promise.resolve(Array.from(this.posts.values()));
  }
  transitionStatus(
    _kg: string,
    id: string,
    expectedStatus: ContentStatus,
    newStatus: ContentStatus,
    patch: TransitionStatusPatch,
  ): Promise<ContentPost | null> {
    this.transitionCalls.push({
      id,
      expected: expectedStatus,
      next: newStatus,
    });
    const cur = this.posts.get(id);
    if (!cur) return Promise.resolve(null);
    if (cur.status !== expectedStatus) return Promise.resolve(null);
    const state = cur.toState();
    state.status = newStatus;
    state.updatedAt = patch.updatedAt;
    if (patch.publishedAt !== undefined) state.publishedAt = patch.publishedAt;
    if (patch.scheduledFor !== undefined)
      state.scheduledFor = patch.scheduledFor;
    const updated = ContentPost.fromState(state);
    this.posts.set(id, updated);
    return Promise.resolve(updated);
  }
  listScheduledDue(): Promise<ContentPost[]> {
    return Promise.resolve([]);
  }
  existsBirthdayForChildOnDate(): Promise<boolean> {
    return Promise.resolve(false);
  }
  // helpers
  setStatus(id: string, status: ContentStatus): void {
    const cur = this.posts.get(id);
    if (!cur) return;
    const s = cur.toState();
    s.status = status;
    this.posts.set(id, ContentPost.fromState(s));
  }
  countAll(): number {
    return this.posts.size;
  }
}

class FakeGroupRepo extends GroupRepository {
  groups = new Map<string, { kg: string }>();
  create(_kg: string, _input: CreateGroupInput): Promise<Group> {
    throw new Error('not used');
  }
  findById(kg: string, id: string): Promise<Group | null> {
    const e = this.groups.get(id);
    if (!e || e.kg !== kg) return Promise.resolve(null);
    return Promise.resolve({
      get name() {
        return 'Group';
      },
    } as Group);
  }
  list(_kg: string, _filters?: ListGroupsFilters): Promise<Group[]> {
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

class FakeChildRepo extends ChildRepository {
  children = new Map<string, { kg: string }>();
  create(): Promise<void> {
    return Promise.resolve();
  }
  findById(kg: string, id: string): Promise<Child | null> {
    const e = this.children.get(id);
    if (!e || e.kg !== kg) return Promise.resolve(null);
    return Promise.resolve({
      toState() {
        return {
          id,
          kindergartenId: kg,
          fullName: 'Test Child',
          dateOfBirth: new Date('2020-05-07T00:00:00.000Z'),
          currentGroupId: GROUP,
          status: 'active',
        };
      },
    } as unknown as Child);
  }
  findByKindergartenAndIin(): Promise<Child | null> {
    return Promise.resolve(null);
  }
  update(): Promise<void> {
    return Promise.resolve();
  }
  list(
    _kg: string,
    _filters: ChildListFilters,
    _page: PageRequest,
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

class FakeFileStorage extends FileStoragePort {
  uploads: FileStorageUploadInput[] = [];
  deletes: string[] = [];
  upload(input: FileStorageUploadInput): Promise<FileStorageUploadResult> {
    this.uploads.push(input);
    return Promise.resolve({
      url: `/api/v1/media/${input.key}`,
      key: input.key,
      bytes: input.buffer.length,
    });
  }
  download(): Promise<Buffer> {
    return Promise.resolve(Buffer.from(''));
  }
  delete(key: string): Promise<void> {
    this.deletes.push(key);
    return Promise.resolve();
  }
  getSignedUrl(key: string): Promise<string> {
    return Promise.resolve(`/api/v1/media/${key}`);
  }
}

class FakeNotificationPort extends NotificationPort {
  newsPublished: NotifyContentNewsPublishedInput[] = [];
  qundylyq: NotifyContentQundylyqNewInput[] = [];
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
  notifyContentNewsPublished(e: NotifyContentNewsPublishedInput) {
    this.newsPublished.push(e);
    return Promise.resolve();
  }
  notifyContentQundylyqNew(e: NotifyContentQundylyqNewInput) {
    this.qundylyq.push(e);
    return Promise.resolve();
  }
  notifyContentBirthday(e: NotifyContentBirthdayInput) {
    this.birthdays.push(e);
    return Promise.resolve();
  }
}

class FakeTransactionRunner extends TransactionRunnerPort {
  run<T>(cb: (em: EntityManager) => Promise<T>): Promise<T> {
    return cb({
      query: () => Promise.resolve(undefined),
    } as unknown as EntityManager);
  }
}

const fakeTxRunner: TransactionRunnerPort = new FakeTransactionRunner();

function buildService() {
  const contentRepo = new FakeContentRepo();
  const groupRepo = new FakeGroupRepo();
  const childRepo = new FakeChildRepo();
  const fileStorage = new FakeFileStorage();
  const notification = new FakeNotificationPort();
  const clock = new FakeClock();
  groupRepo.groups.set(GROUP, { kg: KG });
  childRepo.children.set(CHILD, { kg: KG });
  const service = new ContentService(
    contentRepo,
    groupRepo,
    childRepo,
    fileStorage,
    notification,
    fakeTxRunner,
    clock,
  );
  return {
    service,
    contentRepo,
    groupRepo,
    childRepo,
    fileStorage,
    notification,
    clock,
  };
}

describe('ContentService.create', () => {
  it('creates a draft news targeted at all', async () => {
    const { service, contentRepo } = buildService();
    const post = await service.create(
      KG,
      {
        contentType: 'news',
        targetType: 'all',
        title: 'Hello',
        body: 'World',
      },
      USER,
    );
    expect(post.status).toBe('draft');
    expect(post.targetType).toBe('all');
    expect(contentRepo.countAll()).toBe(1);
  });

  it('creates a scheduled post when scheduledFor is in the future', async () => {
    const { service } = buildService();
    const post = await service.create(
      KG,
      {
        contentType: 'news',
        targetType: 'all',
        title: 'Future',
        scheduledFor: FUTURE,
      },
      USER,
    );
    expect(post.status).toBe('scheduled');
    expect(post.scheduledFor).toEqual(FUTURE);
  });

  it('throws when targetType=group and group is not in this kg', async () => {
    const { service, groupRepo } = buildService();
    groupRepo.groups.set('phantom', { kg: KG_OTHER });
    await expect(
      service.create(
        KG,
        {
          contentType: 'news',
          targetType: 'group',
          targetGroupId: 'phantom',
        },
        USER,
      ),
    ).rejects.toBeInstanceOf(GroupNotFoundError);
  });

  it('throws when targetType=child and child is not in this kg', async () => {
    const { service, childRepo } = buildService();
    childRepo.children.set('phantom-child', { kg: KG_OTHER });
    await expect(
      service.create(
        KG,
        {
          contentType: 'news',
          targetType: 'child',
          targetChildId: 'phantom-child',
        },
        USER,
      ),
    ).rejects.toBeInstanceOf(ChildNotFoundError);
  });

  it('rejects scheduled post with scheduledFor in the past', async () => {
    const { service } = buildService();
    const past = new Date(NOW.getTime() - 1000);
    await expect(
      service.create(
        KG,
        {
          contentType: 'news',
          targetType: 'all',
          scheduledFor: past,
        },
        USER,
      ),
    ).rejects.toBeInstanceOf(ContentPostStatusInvalidError);
  });
});

describe('ContentService.update', () => {
  it('rejects when the post is not in this kg', async () => {
    const { service } = buildService();
    await expect(
      service.update(KG, 'missing', { title: 'x' }),
    ).rejects.toBeInstanceOf(ContentPostNotFoundError);
  });

  it('throws status_invalid for published post', async () => {
    const { service, contentRepo } = buildService();
    const created = await service.create(
      KG,
      { contentType: 'news', targetType: 'all', title: 'a' },
      USER,
    );
    contentRepo.setStatus(created.id, 'published');
    await expect(
      service.update(KG, created.id, { title: 'b' }),
    ).rejects.toBeInstanceOf(ContentPostStatusInvalidError);
  });

  it('updates title on a draft post', async () => {
    const { service } = buildService();
    const created = await service.create(
      KG,
      { contentType: 'news', targetType: 'all', title: 'a' },
      USER,
    );
    const updated = await service.update(KG, created.id, { title: 'b' });
    expect(updated.title).toBe('b');
  });

  it('PATCH with only title preserves body and target_group_id (B17 T8 HIGH#1)', async () => {
    const { service, groupRepo } = buildService();
    groupRepo.groups.set(GROUP, { kg: KG });
    const created = await service.create(
      KG,
      {
        contentType: 'news',
        targetType: 'group',
        targetGroupId: GROUP,
        title: 'orig title',
        body: 'orig body',
      },
      USER,
    );
    // Only `title` is in the patch; service must NOT clobber body or
    // target shape because controller no longer sends keys that are
    // absent in DTO.
    const updated = await service.update(KG, created.id, {
      title: 'new title',
    });
    expect(updated.title).toBe('new title');
    expect(updated.body).toBe('orig body');
    expect(updated.targetType).toBe('group');
    expect(updated.targetGroupId).toBe(GROUP);
  });

  it('re-validates target on patch (cross-tenant defense)', async () => {
    const { service, groupRepo } = buildService();
    const created = await service.create(
      KG,
      { contentType: 'news', targetType: 'all', title: 'a' },
      USER,
    );
    groupRepo.groups.set('phantom-group', { kg: KG_OTHER });
    await expect(
      service.update(KG, created.id, {
        targetType: 'group',
        targetGroupId: 'phantom-group',
      }),
    ).rejects.toBeInstanceOf(GroupNotFoundError);
  });
});

describe('ContentService.delete', () => {
  it('throws 404 when not found', async () => {
    const { service } = buildService();
    await expect(service.delete(KG, 'missing')).rejects.toBeInstanceOf(
      ContentPostNotFoundError,
    );
  });

  it('rejects when post is published', async () => {
    const { service, contentRepo } = buildService();
    const created = await service.create(
      KG,
      { contentType: 'news', targetType: 'all' },
      USER,
    );
    contentRepo.setStatus(created.id, 'published');
    await expect(service.delete(KG, created.id)).rejects.toBeInstanceOf(
      ContentPostStatusInvalidError,
    );
  });

  it('deletes a draft and walks mediaUrls into FileStorage.delete', async () => {
    const { service, contentRepo, fileStorage } = buildService();
    const created = await service.create(
      KG,
      {
        contentType: 'news',
        targetType: 'all',
        mediaUrls: ['/api/v1/media/foo/bar.jpg', '/api/v1/media/foo/baz.png'],
      },
      USER,
    );
    await service.delete(KG, created.id);
    expect(contentRepo.countAll()).toBe(0);
    expect(fileStorage.deletes).toEqual(['foo/bar.jpg', 'foo/baz.png']);
  });
});

describe('ContentService.publish', () => {
  it('flips draft → published and emits content.news_published', async () => {
    const { service, notification } = buildService();
    const created = await service.create(
      KG,
      { contentType: 'news', targetType: 'all', title: 'X' },
      USER,
    );
    const published = await service.publish(KG, created.id);
    expect(published.status).toBe('published');
    expect(notification.newsPublished).toHaveLength(1);
    expect(notification.newsPublished[0].contentPostId).toBe(created.id);
  });

  it('flips scheduled → published and emits qundylyq event', async () => {
    const { service, contentRepo, notification } = buildService();
    const created = await service.create(
      KG,
      { contentType: 'qundylyq', targetType: 'all', title: 'May' },
      USER,
    );
    contentRepo.setStatus(created.id, 'scheduled');
    const published = await service.publish(KG, created.id);
    expect(published.status).toBe('published');
    expect(notification.qundylyq).toHaveLength(1);
  });

  it('throws when post is already published', async () => {
    const { service, contentRepo } = buildService();
    const created = await service.create(
      KG,
      { contentType: 'news', targetType: 'all' },
      USER,
    );
    contentRepo.setStatus(created.id, 'published');
    await expect(service.publish(KG, created.id)).rejects.toBeInstanceOf(
      ContentPostStatusInvalidError,
    );
  });

  it('throws 404 when not found', async () => {
    const { service } = buildService();
    await expect(service.publish(KG, 'missing')).rejects.toBeInstanceOf(
      ContentPostNotFoundError,
    );
  });
});

describe('ContentService.schedule', () => {
  it('flips draft → scheduled', async () => {
    const { service } = buildService();
    const created = await service.create(
      KG,
      { contentType: 'news', targetType: 'all' },
      USER,
    );
    const scheduled = await service.schedule(KG, created.id, FUTURE);
    expect(scheduled.status).toBe('scheduled');
    expect(scheduled.scheduledFor).toEqual(FUTURE);
  });

  it('throws when scheduledFor is in the past', async () => {
    const { service } = buildService();
    const created = await service.create(
      KG,
      { contentType: 'news', targetType: 'all' },
      USER,
    );
    const past = new Date(NOW.getTime() - 1000);
    await expect(service.schedule(KG, created.id, past)).rejects.toBeInstanceOf(
      ContentPostStatusInvalidError,
    );
  });
});

describe('ContentService.uploadMedia', () => {
  it('rejects empty buffer', async () => {
    const { service } = buildService();
    await expect(
      service.uploadMedia(KG, {
        buffer: Buffer.alloc(0),
        mimetype: 'image/jpeg',
        originalname: 'a.jpg',
      }),
    ).rejects.toBeInstanceOf(FileUploadError);
  });

  it('rejects unknown mime', async () => {
    const { service } = buildService();
    await expect(
      service.uploadMedia(KG, {
        buffer: Buffer.from('x'),
        mimetype: 'application/pdf',
        originalname: 'a.pdf',
      }),
    ).rejects.toBeInstanceOf(MediaTypeInvalidError);
  });

  it('uploads an image and returns /api/v1/media/<key>', async () => {
    const { service, fileStorage } = buildService();
    const result = await service.uploadMedia(KG, {
      buffer: Buffer.from('img'),
      mimetype: 'image/jpeg',
      originalname: 'photo.jpg',
    });
    expect(result.url.startsWith('/api/v1/media/')).toBe(true);
    expect(fileStorage.uploads).toHaveLength(1);
    expect(fileStorage.uploads[0].contentType).toBe('image/jpeg');
  });

  it('rejects oversized images (>10 MB)', async () => {
    const { service } = buildService();
    const big = Buffer.alloc(10 * 1024 * 1024 + 1);
    await expect(
      service.uploadMedia(KG, {
        buffer: big,
        mimetype: 'image/jpeg',
        originalname: 'big.jpg',
      }),
    ).rejects.toBeInstanceOf(FileUploadError);
  });
});
