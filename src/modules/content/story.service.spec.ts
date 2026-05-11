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
  NotifyContentStoryNewInput,
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
import { ChildGuardian } from '@/modules/child/domain/entities/child-guardian.entity';
import {
  ChildGroupHistoryRecord,
  ChildListFilters,
  ChildRepository,
  PageRequest,
  PageResult,
} from '@/modules/child/infrastructure/persistence/child.repository';
import { ChildGuardianRepository } from '@/modules/child/infrastructure/persistence/child-guardian.repository';
import { Group } from '@/modules/group/domain/entities/group.entity';
import { GroupMentor } from '@/modules/group/domain/entities/group-mentor.entity';
import {
  CreateGroupInput,
  GroupRepository,
  ListGroupsFilters,
  UpdateGroupInput,
} from '@/modules/group/infrastructure/persistence/group.repository';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { ForbiddenActionError } from '@/shared-kernel/domain/errors';
import {
  FileStoragePort,
  FileStorageUploadInput,
  FileStorageUploadResult,
} from '@/shared-kernel/storage/file-storage.port';
import {
  GroupStory,
  GroupStoryState,
} from './domain/entities/group-story.entity';
import { FileUploadError } from './domain/errors/file-upload.error';
import { GroupStoryExpiredError } from './domain/errors/group-story-expired.error';
import { GroupStoryNotFoundError } from './domain/errors/group-story-not-found.error';
import { MediaTypeInvalidError } from './domain/errors/media-type-invalid.error';
import { GroupNotFoundError } from '@/modules/group/domain/errors/group-not-found.error';
import { GroupStoryRepository } from './group-story.repository';
import { StoryService } from './story.service';

const KG = '11111111-1111-1111-1111-111111111111';
const KG_OTHER = '22222222-2222-2222-2222-222222222222';
const GROUP = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const AUTHOR = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const OTHER = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const NOW = new Date('2026-05-07T12:00:00.000Z');

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

class FakeStoryRepo extends GroupStoryRepository {
  stories = new Map<string, GroupStory>();
  incrementCalls = 0;
  create(s: GroupStory): Promise<GroupStory> {
    this.stories.set(s.id, s);
    return Promise.resolve(s);
  }
  findById(_kg: string, id: string): Promise<GroupStory | null> {
    return Promise.resolve(this.stories.get(id) ?? null);
  }
  delete(kg: string, id: string): Promise<boolean> {
    return this.deleteById(kg, id);
  }
  deleteById(_kg: string, id: string): Promise<boolean> {
    return Promise.resolve(this.stories.delete(id));
  }
  listActiveByGroup(): Promise<GroupStory[]> {
    return Promise.resolve(Array.from(this.stories.values()));
  }
  listActiveByGroupIds(): Promise<GroupStory[]> {
    return Promise.resolve(Array.from(this.stories.values()));
  }
  incrementViews(_kg: string, _id: string): Promise<boolean> {
    this.incrementCalls += 1;
    return Promise.resolve(true);
  }
  listExpired(): Promise<GroupStory[]> {
    return Promise.resolve([]);
  }
}

class FakeGroupRepo extends GroupRepository {
  groups = new Map<string, { kg: string }>();
  mentorAssignments = new Set<string>(); // key = `${kg}:${userId}:${groupId}`
  create(_kg: string, _input: CreateGroupInput): Promise<Group> {
    throw new Error('not used');
  }
  findById(kg: string, id: string): Promise<Group | null> {
    const e = this.groups.get(id);
    if (!e || e.kg !== kg) return Promise.resolve(null);
    return Promise.resolve({} as Group);
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
  isUserActiveMentorForGroup(
    kg: string,
    userId: string,
    groupId: string,
  ): Promise<boolean> {
    return Promise.resolve(
      this.mentorAssignments.has(`${kg}:${userId}:${groupId}`),
    );
  }
}

class FakeChildRepo extends ChildRepository {
  children = new Map<string, { kg: string; groupId: string | null }>();
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
          fullName: 'Child',
          dateOfBirth: new Date('2020-01-01'),
          currentGroupId: e.groupId,
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

class FakeChildGuardianRepo extends ChildGuardianRepository {
  guardians: ChildGuardian[] = [];
  create(): Promise<void> {
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
  findApprovedByUser(_kg: string, userId: string): Promise<ChildGuardian[]> {
    return Promise.resolve(
      this.guardians.filter((g) => g.toState().userId === userId),
    );
  }
  findPendingPrimaryByUserIdCrossTenant(): Promise<ChildGuardian[]> {
    return Promise.resolve([]);
  }
  findApprovedActivePickupGuardian(): Promise<ChildGuardian | null> {
    return Promise.resolve(null);
  }
  findApprovedActiveByUserAndChild(): Promise<ChildGuardian | null> {
    return Promise.resolve(null);
  }
  findApprovedActiveByUserIdCrossTenant(): Promise<ChildGuardian[]> {
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
  storyEvents: NotifyContentStoryNewInput[] = [];

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
  notifyContentStoryNew(e: NotifyContentStoryNewInput) {
    this.storyEvents.push(e);
    return Promise.resolve();
  }
}

const fakeDataSource = {
  transaction: async <T>(cb: (em: unknown) => Promise<T>): Promise<T> =>
    cb({ query: () => Promise.resolve(undefined) }),
} as unknown as DataSource;

function buildService() {
  const storyRepo = new FakeStoryRepo();
  const groupRepo = new FakeGroupRepo();
  const fileStorage = new FakeFileStorage();
  const notification = new FakeNotificationPort();
  const clock = new FakeClock();
  const childRepo = new FakeChildRepo();
  const guardianRepo = new FakeChildGuardianRepo();
  groupRepo.groups.set(GROUP, { kg: KG });
  const service = new StoryService(
    storyRepo,
    groupRepo,
    fileStorage,
    notification,
    fakeDataSource,
    clock,
    childRepo,
    guardianRepo,
  );
  return {
    service,
    storyRepo,
    groupRepo,
    fileStorage,
    notification,
    clock,
    childRepo,
    guardianRepo,
  };
}

function seedExpired(repo: FakeStoryRepo, id: string): GroupStory {
  const state: GroupStoryState = {
    id,
    kindergartenId: KG,
    groupId: GROUP,
    createdBy: AUTHOR,
    mediaUrl: '/api/v1/media/foo.jpg',
    mediaType: 'image',
    caption: null,
    views: 5,
    expiresAt: new Date(NOW.getTime() - 1000),
    createdAt: new Date(NOW.getTime() - 25 * 60 * 60 * 1000),
  };
  const story = GroupStory.fromState(state);
  repo.stories.set(id, story);
  return story;
}

describe('StoryService.create', () => {
  it('throws GroupNotFoundError if group not in kg', async () => {
    const { service, groupRepo } = buildService();
    groupRepo.groups.set('phantom', { kg: KG_OTHER });
    await expect(
      service.create(KG, 'phantom', AUTHOR, {
        buffer: Buffer.from('x'),
        mimetype: 'image/jpeg',
        originalname: 'a.jpg',
      }),
    ).rejects.toBeInstanceOf(GroupNotFoundError);
  });

  it('rejects empty buffer', async () => {
    const { service } = buildService();
    await expect(
      service.create(KG, GROUP, AUTHOR, {
        buffer: Buffer.alloc(0),
        mimetype: 'image/jpeg',
        originalname: 'a.jpg',
      }),
    ).rejects.toBeInstanceOf(FileUploadError);
  });

  it('rejects unknown mime', async () => {
    const { service } = buildService();
    await expect(
      service.create(KG, GROUP, AUTHOR, {
        buffer: Buffer.from('x'),
        mimetype: 'application/pdf',
        originalname: 'a.pdf',
      }),
    ).rejects.toBeInstanceOf(MediaTypeInvalidError);
  });

  it('creates an image story and emits content.story_new', async () => {
    const { service, notification, fileStorage, storyRepo } = buildService();
    const story = await service.create(KG, GROUP, AUTHOR, {
      buffer: Buffer.from('img'),
      mimetype: 'image/jpeg',
      originalname: 'photo.jpg',
      caption: 'hello',
    });
    expect(story.mediaType).toBe('image');
    expect(story.caption).toBe('hello');
    expect(fileStorage.uploads).toHaveLength(1);
    expect(notification.storyEvents).toHaveLength(1);
    expect(notification.storyEvents[0].storyId).toBe(story.id);
    expect(storyRepo.stories.get(story.id)).toBeTruthy();
  });

  it('creates a video story', async () => {
    const { service } = buildService();
    const story = await service.create(KG, GROUP, AUTHOR, {
      buffer: Buffer.from('vid'),
      mimetype: 'video/mp4',
      originalname: 'v.mp4',
    });
    expect(story.mediaType).toBe('video');
    expect(story.caption).toBeNull();
  });

  it('rejects oversized images', async () => {
    const { service } = buildService();
    await expect(
      service.create(KG, GROUP, AUTHOR, {
        buffer: Buffer.alloc(10 * 1024 * 1024 + 1),
        mimetype: 'image/jpeg',
        originalname: 'big.jpg',
      }),
    ).rejects.toBeInstanceOf(FileUploadError);
  });
});

describe('StoryService.delete', () => {
  it('throws 404 when missing', async () => {
    const { service } = buildService();
    await expect(
      service.delete(KG, 'missing', { userId: AUTHOR, role: 'mentor' }),
    ).rejects.toBeInstanceOf(GroupStoryNotFoundError);
  });

  it('allows author to delete and triggers FileStorage.delete', async () => {
    const { service, storyRepo, fileStorage } = buildService();
    const created = await service.create(KG, GROUP, AUTHOR, {
      buffer: Buffer.from('img'),
      mimetype: 'image/jpeg',
      originalname: 'photo.jpg',
    });
    await service.delete(KG, created.id, { userId: AUTHOR, role: 'mentor' });
    expect(storyRepo.stories.has(created.id)).toBe(false);
    // The /api/v1/media/<key> => key strip
    expect(fileStorage.deletes).toHaveLength(1);
  });

  it('allows admin to delete (not author)', async () => {
    const { service, storyRepo } = buildService();
    const created = await service.create(KG, GROUP, AUTHOR, {
      buffer: Buffer.from('img'),
      mimetype: 'image/jpeg',
      originalname: 'photo.jpg',
    });
    await service.delete(KG, created.id, { userId: OTHER, role: 'admin' });
    expect(storyRepo.stories.has(created.id)).toBe(false);
  });

  it('rejects non-author non-admin delete with 403', async () => {
    const { service } = buildService();
    const created = await service.create(KG, GROUP, AUTHOR, {
      buffer: Buffer.from('img'),
      mimetype: 'image/jpeg',
      originalname: 'photo.jpg',
    });
    await expect(
      service.delete(KG, created.id, { userId: OTHER, role: 'mentor' }),
    ).rejects.toBeInstanceOf(ForbiddenActionError);
  });
});

describe('StoryService.incrementViews', () => {
  it('throws 404 when missing', async () => {
    const { service } = buildService();
    await expect(service.incrementViews(KG, 'missing')).rejects.toBeInstanceOf(
      GroupStoryNotFoundError,
    );
  });

  it('throws 410 when story expired', async () => {
    const { service, storyRepo } = buildService();
    const expired = seedExpired(storyRepo, 'expired-1');
    await expect(service.incrementViews(KG, expired.id)).rejects.toBeInstanceOf(
      GroupStoryExpiredError,
    );
  });

  it('increments views on a fresh story', async () => {
    const { service, storyRepo } = buildService();
    const created = await service.create(KG, GROUP, AUTHOR, {
      buffer: Buffer.from('img'),
      mimetype: 'image/jpeg',
      originalname: 'photo.jpg',
    });
    await service.incrementViews(KG, created.id);
    expect(storyRepo.incrementCalls).toBe(1);
  });
});

describe('StoryService.listActiveByGroup', () => {
  it('returns stories from the repo via clock.now()', async () => {
    const { service } = buildService();
    await service.create(KG, GROUP, AUTHOR, {
      buffer: Buffer.from('img'),
      mimetype: 'image/jpeg',
      originalname: 'p.jpg',
    });
    const list = await service.listActiveByGroup(KG, GROUP);
    expect(list).toHaveLength(1);
  });
});

describe('StoryService.create — mentor scope (B17 T8 HIGH#3)', () => {
  it('rejects mentor when not assigned to the group', async () => {
    const { service } = buildService();
    await expect(
      service.create(
        KG,
        GROUP,
        AUTHOR,
        {
          buffer: Buffer.from('img'),
          mimetype: 'image/jpeg',
          originalname: 'p.jpg',
        },
        { userId: AUTHOR, role: 'mentor' },
      ),
    ).rejects.toBeInstanceOf(ForbiddenActionError);
  });

  it('allows mentor when assigned to the group', async () => {
    const { service, groupRepo } = buildService();
    groupRepo.mentorAssignments.add(`${KG}:${AUTHOR}:${GROUP}`);
    const story = await service.create(
      KG,
      GROUP,
      AUTHOR,
      {
        buffer: Buffer.from('img'),
        mimetype: 'image/jpeg',
        originalname: 'p.jpg',
      },
      { userId: AUTHOR, role: 'mentor' },
    );
    expect(story.id).toBeDefined();
  });

  it('allows admin without group-assignment check', async () => {
    const { service } = buildService();
    const story = await service.create(
      KG,
      GROUP,
      AUTHOR,
      {
        buffer: Buffer.from('img'),
        mimetype: 'image/jpeg',
        originalname: 'p.jpg',
      },
      { userId: AUTHOR, role: 'admin' },
    );
    expect(story.id).toBeDefined();
  });
});

describe('StoryService.incrementViews — parent scope (B17 T8 MEDIUM#1)', () => {
  it('rejects parent who is not a guardian of any child in the story group', async () => {
    const { service, storyRepo } = buildService();
    const created = await service.create(KG, GROUP, AUTHOR, {
      buffer: Buffer.from('img'),
      mimetype: 'image/jpeg',
      originalname: 'p.jpg',
    });
    expect(storyRepo.stories.has(created.id)).toBe(true);
    await expect(
      service.incrementViews(KG, created.id, {
        userId: OTHER,
        role: 'parent',
      }),
    ).rejects.toBeInstanceOf(ForbiddenActionError);
  });

  it('allows parent who has an approved-active guardian for a child in the story group', async () => {
    const { service, childRepo, guardianRepo } = buildService();
    const created = await service.create(KG, GROUP, AUTHOR, {
      buffer: Buffer.from('img'),
      mimetype: 'image/jpeg',
      originalname: 'p.jpg',
    });
    const CHILD_X = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    const GUARDIAN_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    childRepo.children.set(CHILD_X, { kg: KG, groupId: GROUP });
    const guardian = ChildGuardian.hydrate({
      id: GUARDIAN_ID,
      kindergartenId: KG,
      childId: CHILD_X,
      userId: OTHER,
      role: 'primary',
      status: 'approved',
      hasApprovalRights: true,
      approvedBy: null,
      approvedAt: null,
      revokedBy: null,
      revokedAt: null,
      canPickup: true,
      permissions: {},
      permissionsUpdatedBy: null,
      permissionsUpdatedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    guardianRepo.guardians.push(guardian);
    await expect(
      service.incrementViews(KG, created.id, {
        userId: OTHER,
        role: 'parent',
      }),
    ).resolves.toBeUndefined();
  });

  it('admin/mentor bypass parent guardian check', async () => {
    const { service } = buildService();
    const created = await service.create(KG, GROUP, AUTHOR, {
      buffer: Buffer.from('img'),
      mimetype: 'image/jpeg',
      originalname: 'p.jpg',
    });
    await expect(
      service.incrementViews(KG, created.id, {
        userId: OTHER,
        role: 'admin',
      }),
    ).resolves.toBeUndefined();
    await expect(
      service.incrementViews(KG, created.id, {
        userId: AUTHOR,
        role: 'mentor',
      }),
    ).resolves.toBeUndefined();
  });
});
