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

  /**
   * Parent-side per-child stories list. Looks up the child to discover its
   * `current_group_id`, then returns the active stories for that group. If
   * the child is unfound (`ChildAccessGuard` should already have caught
   * this in the HTTP path) or has no group assignment, returns `[]`.
   *
   * Pulled out of `ParentContentController` so the controller layer no
   * longer touches `ChildRepository` / `GroupStoryRepository` directly
   * (CLAUDE.md §4 — controllers stay thin HTTP-edge).
   */
  async listActiveStoriesForChild(
    kindergartenId: string,
    childId: string,
  ): Promise<GroupStory[]> {
    const child = await this.childRepo.findById(kindergartenId, childId);
    if (!child) {
      // ChildAccessGuard should have caught this already, but guard defensively.
      return [];
    }
    const childState = child.toState();
    const groupId = childState.currentGroupId;
    if (!groupId) {
      return [];
    }
    const now = this.clock.now();
    return this.storyRepo.listActiveByGroup(kindergartenId, groupId, now);
  }

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

    // B22b T9 UNION ALL optimisation: news targeting uses a single
    // SQL query with an OR predicate that covers all three buckets
    // (target_type='all' | 'group' | 'child') in one round-trip.
    // Previously this required 3 parallel list() calls + in-memory
    // merge/dedupe; now one listNewsForChild() call returns a sorted,
    // deduplicated slice directly from Postgres.
    const [news, qundylyq, birthdays, stories] = await Promise.all([
      this.contentRepo.listNewsForChild(
        kindergartenId,
        childId,
        groupId,
        limit,
      ),
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
