import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { ChildService } from '@/modules/child/child.service';
import { Child } from '@/modules/child/domain/entities/child.entity';
import { ChildGuardian } from '@/modules/child/domain/entities/child-guardian.entity';
import { ChildRepository } from '@/modules/child/infrastructure/persistence/child.repository';
import { ChildDailyStatusRepository } from '@/modules/attendance/infrastructure/persistence/child-daily-status.repository';
import { Group } from '@/modules/group/domain/entities/group.entity';
import { GroupRepository } from '@/modules/group/infrastructure/persistence/group.repository';
import { LocationRepository } from '@/modules/location/infrastructure/persistence/location.repository';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { decodeCursor, encodeCursor } from './cursor.util';

/** Almaty is UTC+5, no DST — a local civil date is the UTC instant shifted +5h. */
const ALMATY_OFFSET_MS = 5 * 60 * 60 * 1000;

const DEFAULT_LIMIT = 20;

export interface MyGroupView {
  id: string;
  name: string;
  ageRangeMin: number | null;
  ageRangeMax: number | null;
  room: string | null;
  isPrimary: boolean;
  childrenCount: number;
}

export interface RosterChildView {
  child: Child;
  dayStatus: string | null;
}

export interface RosterPageView {
  items: RosterChildView[];
  nextCursor: string | null;
}

export interface ChildCardView {
  child: Child;
  groupName: string | null;
  guardians: Array<{
    guardian: ChildGuardian;
    fullName: string | null;
    phone: string | null;
  }>;
}

interface PageParams {
  limit?: number;
  cursor?: string;
}

/**
 * StaffPortalService — read-only Staff-App composition layer.
 *
 * Owns no table / migration / domain entity (a LEAF module, mirrors
 * DashboardService). It composes already-exported bounded-context
 * services/repositories to assemble the Staff-App read views, threading
 * `kgId` explicitly into every call as defense-in-depth (RLS is the second
 * layer). The presenter does domain → snake_case DTO mapping; this service
 * returns intermediate view objects.
 */
@Injectable()
export class StaffPortalService {
  constructor(
    private readonly groupRepo: GroupRepository,
    private readonly locationRepo: LocationRepository,
    private readonly childService: ChildService,
    private readonly childRepo: ChildRepository,
    private readonly dailyStatusRepo: ChildDailyStatusRepository,
    @Inject(ClockPort) private readonly clock: ClockPort,
  ) {}

  /** Asia/Almaty calendar date (YYYY-MM-DD) for the current instant. */
  private almatyToday(): string {
    const shifted = new Date(this.clock.now().getTime() + ALMATY_OFFSET_MS);
    const y = shifted.getUTCFullYear();
    const m = shifted.getUTCMonth();
    const d = shifted.getUTCDate();
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${y}-${pad(m + 1)}-${pad(d)}`;
  }

  // ── GET /staff/my-groups ─────────────────────────────────────────────────

  /**
   * The caller's active mentor-group assignments with display metadata. One
   * row per active `group_mentors` assignment for `(userId, kgId)`; archived /
   * missing groups are skipped (a stale assignment to a deleted group is not
   * surfaced).
   */
  async listMyGroups(kgId: string, userId: string): Promise<MyGroupView[]> {
    const assignments =
      await this.groupRepo.findActiveMentorAssignmentsByUserIdCrossTenant(
        userId,
        kgId,
      );

    const views: MyGroupView[] = [];
    for (const assignment of assignments) {
      const group = await this.groupRepo.findById(kgId, assignment.groupId);
      if (!group) continue;

      const [room, childrenCount] = await Promise.all([
        this.resolveRoom(kgId, group),
        this.childRepo.countActiveByGroup(kgId, group.id),
      ]);

      views.push({
        id: group.id,
        name: group.name,
        ageRangeMin: group.ageRangeMin,
        ageRangeMax: group.ageRangeMax,
        room,
        isPrimary: assignment.isPrimary,
        childrenCount,
      });
    }
    return views;
  }

  /** Resolve the room (location) display name for a group, or null. */
  private async resolveRoom(
    kgId: string,
    group: Group,
  ): Promise<string | null> {
    if (!group.currentLocationId) return null;
    const location = await this.locationRepo.findById(
      kgId,
      group.currentLocationId,
    );
    return location?.name ?? null;
  }

  // ── GET /staff/my-groups/:groupId/children ───────────────────────────────

  /**
   * Roster of active children in `groupId` for a mentor. The caller MUST hold
   * an active mentor assignment for the group in THIS kindergarten — otherwise
   * `ForbiddenException({ code: 'mentor_not_assigned_to_group' })`. The
   * assignment check is scoped to `kgId`, so a mentor of kg_A cannot read
   * kg_B's roster even with a kg_B-shaped groupId (cross-tenant guard).
   */
  async listGroupRoster(
    kgId: string,
    userId: string,
    groupId: string,
    page: PageParams,
  ): Promise<RosterPageView> {
    const assignments =
      await this.groupRepo.findActiveMentorAssignmentsByUserIdCrossTenant(
        userId,
        kgId,
      );
    const assigned = new Set(assignments.map((a) => a.groupId));
    if (!assigned.has(groupId)) {
      throw new ForbiddenException({ code: 'mentor_not_assigned_to_group' });
    }

    return this.listChildrenPage(
      kgId,
      { status: 'active', currentGroupId: groupId },
      page,
    );
  }

  // ── GET /staff/children ──────────────────────────────────────────────────

  /**
   * All active children of the caller's kindergarten (specialist child-picker
   * for diagnostics). No group filter — kg-wide. Same paginated shape as the
   * roster.
   */
  async listSpecialistChildren(
    kgId: string,
    page: PageParams,
  ): Promise<RosterPageView> {
    return this.listChildrenPage(kgId, { status: 'active' }, page);
  }

  /**
   * Shared cursor-paginated child list + today's day_status overlay. Translates
   * the opaque cursor to an offset, calls the existing offset-based
   * `ChildRepository.list`, then batch-overlays today's `child_daily_status`.
   */
  private async listChildrenPage(
    kgId: string,
    filters: { status: 'active'; currentGroupId?: string },
    page: PageParams,
  ): Promise<RosterPageView> {
    const limit = page.limit ?? DEFAULT_LIMIT;
    const offset = page.cursor !== undefined ? decodeCursor(page.cursor) : 0;

    const result = await this.childRepo.list(kgId, filters, { limit, offset });
    const items = result.items;

    // Map childId → today's intraday status (one row per child, today only).
    const today = this.almatyToday();
    const statusRows = await this.dailyStatusRepo.list(kgId, {
      groupId: filters.currentGroupId,
      from: today,
      to: today,
    });
    const statusByChild = new Map<string, string>();
    for (const row of statusRows) {
      statusByChild.set(row.childId, row.status.value);
    }

    // next_cursor is null on the last page: a short page means no more rows.
    // When the page is full we still bound by `total` so we never hand out a
    // cursor that resolves to an empty page.
    const nextOffset = offset + items.length;
    const hasMore = items.length === limit && nextOffset < result.total;

    return {
      items: items.map((child) => ({
        child,
        dayStatus: statusByChild.get(child.id) ?? null,
      })),
      nextCursor: hasMore ? encodeCursor(nextOffset) : null,
    };
  }

  // ── GET /staff/children/:id ──────────────────────────────────────────────

  /**
   * Full staff-facing child card. Kindergarten-scoped — `ChildService.getChild`
   * throws `ChildNotFoundError` (→ 404) when the child is not in `kgId`, which
   * is the cross-tenant guard. Guardians are filtered to APPROVED rows only
   * (revoked / rejected / pending are not surfaced on the staff card — matches
   * the "active guardians" intent of the Staff App child card), and the
   * full_name / phone identity is overlaid from the linked users row exactly as
   * the admin card does (`ChildService.resolveGuardianIdentities`).
   */
  async getChildCard(kgId: string, childId: string): Promise<ChildCardView> {
    const { child, guardians } = await this.childService.getChild(
      kgId,
      childId,
    );

    const approved = guardians.filter((g) => g.toState().status === 'approved');

    const [groupName, identities] = await Promise.all([
      this.childService.resolveGroupName(kgId, child),
      this.childService.resolveGuardianIdentities(approved),
    ]);

    return {
      child,
      groupName,
      guardians: approved.map((guardian) => {
        const identity = identities.get(guardian.userId);
        return {
          guardian,
          fullName: identity?.fullName ?? null,
          phone: identity?.phone ?? null,
        };
      }),
    };
  }
}
