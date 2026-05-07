import { Inject, Injectable } from '@nestjs/common';
import { ChildRepository } from '@/modules/child/infrastructure/persistence/child.repository';
import { ChildNotFoundError } from '@/modules/child/domain/errors/child-not-found.error';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { ContentRepository } from './content.repository';
import { ContentPost } from './domain/entities/content-post.entity';
import { GroupStory } from './domain/entities/group-story.entity';
import { GroupStoryRepository } from './group-story.repository';

export interface ContentFeedResult {
  news: ContentPost[];
  qundylyq: ContentPost[];
  birthdays: ContentPost[];
  stories: GroupStory[];
  /** B22 cross-feed integration — TODO. */
  menuToday: null;
  /** B22 cross-feed integration — TODO. */
  scheduleToday: null;
}

export interface GetParentChildFeedOptions {
  /**
   * Per-section list cap. Defaults to 10. Stories use the cap directly;
   * `news`/`qundylyq`/`birthdays` use it for the most-recent slice.
   */
  limit?: number;
}

const DEFAULT_FEED_LIMIT = 10;

/**
 * ContentFeedService — read-side aggregation for the parent child-feed
 * surface (BP §9).
 *
 *   - Parallel-fetches (`Promise.all`) the four content-post slices
 *     (`news`, `qundylyq`, `birthday`) and active stories for the child's
 *     current group.
 *   - Returns `null` placeholders for `menu_today` / `schedule_today` —
 *     B22 will wire these to the `meal_plans` + `daily_schedule` modules
 *     once those land.
 */
@Injectable()
export class ContentFeedService {
  constructor(
    private readonly contentRepo: ContentRepository,
    private readonly childRepo: ChildRepository,
    private readonly storyRepo: GroupStoryRepository,
    @Inject(ClockPort) private readonly clock: ClockPort,
  ) {}

  async getParentChildFeed(
    kindergartenId: string,
    childId: string,
    options: GetParentChildFeedOptions = {},
  ): Promise<ContentFeedResult> {
    const child = await this.childRepo.findById(kindergartenId, childId);
    if (!child) throw new ChildNotFoundError(childId);
    const childState = child.toState();
    const groupId = childState.currentGroupId;
    const now = this.clock.now();
    const limit = options.limit ?? DEFAULT_FEED_LIMIT;

    // News: target_type='all' OR target_group_id=group OR target_child_id=child.
    // The repo's filter shape doesn't model OR-of-targets, so we fan out
    // three queries in parallel and merge/dedupe by id.
    const [newsAll, newsGroup, newsChild, qundylyq, birthdays, stories] =
      await Promise.all([
        this.contentRepo.list(kindergartenId, {
          contentType: 'news',
          status: 'published',
          targetType: 'all',
          limit,
        }),
        groupId
          ? this.contentRepo.list(kindergartenId, {
              contentType: 'news',
              status: 'published',
              targetType: 'group',
              targetGroupId: groupId,
              limit,
            })
          : Promise.resolve<ContentPost[]>([]),
        this.contentRepo.list(kindergartenId, {
          contentType: 'news',
          status: 'published',
          targetType: 'child',
          targetChildId: childId,
          limit,
        }),
        this.contentRepo.list(kindergartenId, {
          contentType: 'qundylyq',
          status: 'published',
          limit,
        }),
        this.contentRepo.list(kindergartenId, {
          contentType: 'birthday',
          status: 'published',
          targetChildId: childId,
          limit,
        }),
        groupId
          ? this.storyRepo.listActiveByGroup(kindergartenId, groupId, now)
          : Promise.resolve<GroupStory[]>([]),
      ]);

    const news = mergeUniqueSorted([newsAll, newsGroup, newsChild], limit);

    // TODO(B22): wire menuToday / scheduleToday to meal-plans +
    // daily_schedule modules once those land.
    return {
      news,
      qundylyq,
      birthdays,
      stories,
      menuToday: null,
      scheduleToday: null,
    };
  }
}

/**
 * Merge multiple `ContentPost[]` lists, dedupe by `id`, sort by
 * `publishedAt DESC` then `createdAt DESC`, and slice to `limit`.
 */
function mergeUniqueSorted(
  buckets: ContentPost[][],
  limit: number,
): ContentPost[] {
  const seen = new Set<string>();
  const out: ContentPost[] = [];
  for (const b of buckets) {
    for (const p of b) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      out.push(p);
    }
  }
  out.sort((a, b) => {
    const aP = a.publishedAt?.getTime() ?? a.createdAt.getTime();
    const bP = b.publishedAt?.getTime() ?? b.createdAt.getTime();
    if (aP !== bP) return bP - aP;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });
  return out.slice(0, limit);
}
