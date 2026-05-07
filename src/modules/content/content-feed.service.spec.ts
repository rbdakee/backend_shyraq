import { ChildNotFoundError } from '@/modules/child/domain/errors/child-not-found.error';
import { Child } from '@/modules/child/domain/entities/child.entity';
import {
  ChildGroupHistoryRecord,
  ChildListFilters,
  ChildRepository,
  PageRequest,
  PageResult,
} from '@/modules/child/infrastructure/persistence/child.repository';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { ContentFeedService } from './content-feed.service';
import {
  ContentRepository,
  ListContentFilters,
  TransitionStatusPatch,
} from './content.repository';
import {
  ContentPost,
  ContentPostState,
  ContentStatus,
  ContentType,
} from './domain/entities/content-post.entity';
import { GroupStory } from './domain/entities/group-story.entity';
import { GroupStoryRepository } from './group-story.repository';

const KG = '11111111-1111-1111-1111-111111111111';
const GROUP = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CHILD = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const NOW = new Date('2026-05-07T12:00:00.000Z');

class FakeClock extends ClockPort {
  now(): Date {
    return NOW;
  }
}

function makePost(
  id: string,
  contentType: ContentType,
  overrides: Partial<ContentPostState> = {},
): ContentPost {
  return ContentPost.fromState({
    id,
    kindergartenId: KG,
    contentType,
    targetType: 'all',
    targetGroupId: null,
    targetChildId: null,
    title: null,
    body: null,
    titleI18n: null,
    bodyI18n: null,
    mediaUrls: null,
    metadata: null,
    scheduledFor: null,
    publishedAt: NOW,
    expiresAt: null,
    status: 'published',
    createdBy: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

class FakeContentRepo extends ContentRepository {
  records: ContentPost[] = [];
  create(p: ContentPost): Promise<ContentPost> {
    this.records.push(p);
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
  list(_kg: string, filters: ListContentFilters): Promise<ContentPost[]> {
    return Promise.resolve(
      this.records.filter((p) => {
        if (
          filters.contentType !== undefined &&
          p.contentType !== filters.contentType
        )
          return false;
        if (filters.status !== undefined && p.status !== filters.status)
          return false;
        if (
          filters.targetType !== undefined &&
          p.targetType !== filters.targetType
        )
          return false;
        if (
          filters.targetGroupId !== undefined &&
          p.targetGroupId !== filters.targetGroupId
        )
          return false;
        if (
          filters.targetChildId !== undefined &&
          p.targetChildId !== filters.targetChildId
        )
          return false;
        return true;
      }),
    );
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
  existsBirthdayForChildOnDate(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

class FakeChildRepo extends ChildRepository {
  byId = new Map<string, Child>();
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

class FakeStoryRepo extends GroupStoryRepository {
  byGroup = new Map<string, GroupStory[]>();
  create(s: GroupStory): Promise<GroupStory> {
    return Promise.resolve(s);
  }
  findById(): Promise<GroupStory | null> {
    return Promise.resolve(null);
  }
  delete(): Promise<boolean> {
    return Promise.resolve(true);
  }
  deleteById(): Promise<boolean> {
    return Promise.resolve(true);
  }
  listActiveByGroup(_kg: string, gid: string): Promise<GroupStory[]> {
    return Promise.resolve(this.byGroup.get(gid) ?? []);
  }
  listActiveByGroupIds(): Promise<GroupStory[]> {
    return Promise.resolve([]);
  }
  incrementViews(): Promise<boolean> {
    return Promise.resolve(true);
  }
  listExpired(): Promise<GroupStory[]> {
    return Promise.resolve([]);
  }
}

function makeChild(id: string, groupId: string | null): Child {
  return {
    toState: () => ({
      id,
      kindergartenId: KG,
      currentGroupId: groupId,
      fullName: 'Test',
      dateOfBirth: new Date('2020-01-01'),
      status: 'active',
    }),
  } as unknown as Child;
}

function buildService() {
  const contentRepo = new FakeContentRepo();
  const childRepo = new FakeChildRepo();
  const storyRepo = new FakeStoryRepo();
  const service = new ContentFeedService(
    contentRepo,
    childRepo,
    storyRepo,
    new FakeClock(),
  );
  return { service, contentRepo, childRepo, storyRepo };
}

describe('ContentFeedService.getParentChildFeed', () => {
  it('throws ChildNotFoundError when child not in kg', async () => {
    const { service } = buildService();
    await expect(service.getParentChildFeed(KG, CHILD)).rejects.toBeInstanceOf(
      ChildNotFoundError,
    );
  });

  it('returns empty arrays when no posts exist', async () => {
    const { service, childRepo } = buildService();
    childRepo.byId.set(CHILD, makeChild(CHILD, GROUP));
    const feed = await service.getParentChildFeed(KG, CHILD);
    expect(feed.news).toEqual([]);
    expect(feed.qundylyq).toEqual([]);
    expect(feed.birthdays).toEqual([]);
    expect(feed.stories).toEqual([]);
    expect(feed.menuToday).toBeNull();
    expect(feed.scheduleToday).toBeNull();
  });

  it('aggregates news from all/group/child target_types', async () => {
    const { service, contentRepo, childRepo } = buildService();
    childRepo.byId.set(CHILD, makeChild(CHILD, GROUP));
    contentRepo.records.push(
      makePost('p1', 'news', { targetType: 'all' }),
      makePost('p2', 'news', {
        targetType: 'group',
        targetGroupId: GROUP,
      }),
      makePost('p3', 'news', {
        targetType: 'child',
        targetChildId: CHILD,
      }),
      makePost('p4', 'news', {
        targetType: 'group',
        targetGroupId: 'other-group',
      }),
    );
    const feed = await service.getParentChildFeed(KG, CHILD);
    const ids = feed.news.map((n) => n.id).sort();
    expect(ids).toEqual(['p1', 'p2', 'p3']);
  });

  it('returns child-only birthday posts', async () => {
    const { service, contentRepo, childRepo } = buildService();
    childRepo.byId.set(CHILD, makeChild(CHILD, GROUP));
    contentRepo.records.push(
      makePost('b1', 'birthday', {
        targetType: 'child',
        targetChildId: CHILD,
      }),
      makePost('b2', 'birthday', {
        targetType: 'child',
        targetChildId: 'someone-else',
      }),
    );
    const feed = await service.getParentChildFeed(KG, CHILD);
    expect(feed.birthdays.map((p) => p.id)).toEqual(['b1']);
  });

  it('falls through stories when child has no current group', async () => {
    const { service, childRepo } = buildService();
    childRepo.byId.set(CHILD, makeChild(CHILD, null));
    const feed = await service.getParentChildFeed(KG, CHILD);
    expect(feed.stories).toEqual([]);
  });

  it('returns stories for the child group when present', async () => {
    const { service, childRepo, storyRepo } = buildService();
    childRepo.byId.set(CHILD, makeChild(CHILD, GROUP));
    const story = GroupStory.create({
      id: 'story-1',
      kindergartenId: KG,
      groupId: GROUP,
      createdBy: 'creator',
      mediaUrl: '/static/x.jpg',
      mediaType: 'image',
      now: NOW,
    });
    storyRepo.byGroup.set(GROUP, [story]);
    const feed = await service.getParentChildFeed(KG, CHILD);
    expect(feed.stories).toHaveLength(1);
    expect(feed.stories[0].id).toBe('story-1');
  });

  it('caps news to provided limit', async () => {
    const { service, contentRepo, childRepo } = buildService();
    childRepo.byId.set(CHILD, makeChild(CHILD, GROUP));
    for (let i = 0; i < 25; i++) {
      contentRepo.records.push(
        makePost(`p${i}`, 'news', {
          targetType: 'all',
          publishedAt: new Date(NOW.getTime() - i * 1000),
        }),
      );
    }
    const feed = await service.getParentChildFeed(KG, CHILD, { limit: 5 });
    expect(feed.news).toHaveLength(5);
  });

  it('dedupes news posts that match multiple target buckets (no double-count)', async () => {
    const { service, contentRepo, childRepo } = buildService();
    childRepo.byId.set(CHILD, makeChild(CHILD, GROUP));
    // Same id appearing in two simulated buckets — should only count once.
    const post = makePost('dup', 'news', { targetType: 'all' });
    contentRepo.records.push(post);
    // Force a second list-call to return same post id by also adding a
    // group-targeted variant with same id.
    const dup = makePost('dup', 'news', {
      targetType: 'group',
      targetGroupId: GROUP,
    });
    contentRepo.records.push(dup);
    const feed = await service.getParentChildFeed(KG, CHILD);
    const ids = feed.news.map((n) => n.id);
    expect(ids.filter((i) => i === 'dup').length).toBe(1);
  });
});
