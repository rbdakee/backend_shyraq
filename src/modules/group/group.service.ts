import { Inject, Injectable } from '@nestjs/common';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { LocationRepository } from '@/modules/location/infrastructure/persistence/location.repository';
import { LocationNotFoundError } from '@/modules/location/domain/errors/location-not-found.error';
import { StaffMemberRepository } from '@/modules/staff/infrastructure/persistence/staff-member.repository';
import { StaffNotFoundError } from '@/modules/staff/domain/errors/staff-not-found.error';
import { Group } from './domain/entities/group.entity';
import { GroupMentor } from './domain/entities/group-mentor.entity';
import { GroupArchivedError } from './domain/errors/group-archived.error';
import { GroupNotFoundError } from './domain/errors/group-not-found.error';
import { MentorNotEligibleError } from './domain/errors/mentor-not-eligible.error';
import {
  CreateGroupInput,
  GroupRepository,
  ListGroupsFilters,
  UpdateGroupInput,
} from './infrastructure/persistence/group.repository';

/**
 * GroupService — admin-scoped CRUD over the groups + group_mentors aggregate.
 *
 * Mentor assignment is the rich-aggregate operation here: every assignMentor
 * call closes the previously-active group_mentors row (set unassigned_at=now)
 * and inserts a fresh row in the same TX, so the partial-unique
 * `idx_group_mentors_one_active` invariant is always preserved. Concurrent
 * assignments race on that index — the repository surfaces the 23505 violation
 * as `MentorAlreadyActiveError`.
 *
 * Like the rest of the P4 surface, this service explicitly threads
 * `kindergartenId` into every repo call. The `TenantContextInterceptor` adds
 * RLS as defense-in-depth at the DB layer.
 */
@Injectable()
export class GroupService {
  constructor(
    private readonly groups: GroupRepository,
    private readonly locations: LocationRepository,
    private readonly staff: StaffMemberRepository,
    @Inject(ClockPort) private readonly clock: ClockPort,
  ) {}

  // ── reads ────────────────────────────────────────────────────────────────

  list(kindergartenId: string, filters?: ListGroupsFilters): Promise<Group[]> {
    return this.groups.list(kindergartenId, filters);
  }

  async getById(kindergartenId: string, id: string): Promise<Group> {
    const row = await this.groups.findById(kindergartenId, id);
    if (!row) throw new GroupNotFoundError(id);
    return row;
  }

  // ── create / update ──────────────────────────────────────────────────────

  async create(
    kindergartenId: string,
    input: CreateGroupInput,
  ): Promise<Group> {
    Group.validateCapacity(input.capacity);
    Group.validateAgeRange(
      input.ageRangeMin ?? null,
      input.ageRangeMax ?? null,
    );
    if (input.currentLocationId) {
      const loc = await this.locations.findById(
        kindergartenId,
        input.currentLocationId,
      );
      if (!loc) throw new LocationNotFoundError(input.currentLocationId);
    }
    return this.groups.create(kindergartenId, input);
  }

  async update(
    kindergartenId: string,
    id: string,
    patch: UpdateGroupInput,
  ): Promise<Group> {
    const current = await this.groups.findById(kindergartenId, id);
    if (!current) throw new GroupNotFoundError(id);
    if (current.isArchived) throw new GroupArchivedError(id);

    if (patch.capacity !== undefined) Group.validateCapacity(patch.capacity);
    const mergedMin =
      patch.ageRangeMin !== undefined
        ? (patch.ageRangeMin ?? null)
        : current.ageRangeMin;
    const mergedMax =
      patch.ageRangeMax !== undefined
        ? (patch.ageRangeMax ?? null)
        : current.ageRangeMax;
    Group.validateAgeRange(mergedMin, mergedMax);

    if (
      patch.currentLocationId !== undefined &&
      patch.currentLocationId !== null
    ) {
      const loc = await this.locations.findById(
        kindergartenId,
        patch.currentLocationId,
      );
      if (!loc) throw new LocationNotFoundError(patch.currentLocationId);
    }

    const updated = await this.groups.update(kindergartenId, id, patch);
    if (!updated) throw new GroupNotFoundError(id);
    return updated;
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /**
   * Archive a group. We do NOT auto-unassign the active mentor here — the
   * group_mentors row is preserved as part of the historical record. Clients
   * that want to detach the mentor before archiving call /unassign-mentor
   * first.
   */
  async archive(kindergartenId: string, id: string): Promise<Group> {
    const current = await this.groups.findById(kindergartenId, id);
    if (!current) throw new GroupNotFoundError(id);
    if (current.isArchived) return current;
    current.archive(this.clock.now());
    return this.groups.save(current);
  }

  async restore(kindergartenId: string, id: string): Promise<Group> {
    const current = await this.groups.findById(kindergartenId, id);
    if (!current) throw new GroupNotFoundError(id);
    if (!current.isArchived) return current;
    current.restore(this.clock.now());
    return this.groups.save(current);
  }

  // ── mentor assignment ────────────────────────────────────────────────────

  /**
   * Assign a staff_member as the active mentor for a group. The repository
   * closes any existing active row (unassigned_at = now) and inserts a fresh
   * row in the same TX. Pre-checks:
   *   - group exists in this kg, not archived
   *   - staff_member exists in this kg, is active, not archived
   * Concurrent calls race on the partial-unique index — the loser's INSERT
   * fails with 23505, surfaced as `MentorAlreadyActiveError`.
   */
  async assignMentor(
    kindergartenId: string,
    groupId: string,
    staffMemberId: string,
  ): Promise<GroupMentor> {
    const group = await this.groups.findById(kindergartenId, groupId);
    if (!group) throw new GroupNotFoundError(groupId);
    if (group.isArchived) throw new GroupArchivedError(groupId);

    const staff = await this.staff.findById(kindergartenId, staffMemberId);
    if (!staff) throw new StaffNotFoundError(staffMemberId);
    if (!staff.isActive || staff.isArchived) {
      throw new MentorNotEligibleError(staffMemberId);
    }
    if (staff.role !== 'mentor') {
      throw new MentorNotEligibleError(staffMemberId);
    }

    return this.groups.assignMentor(
      kindergartenId,
      groupId,
      staffMemberId,
      this.clock.now(),
    );
  }

  /**
   * Idempotent unassign — if there is no currently-active mentor for the
   * group, returns null without writing.
   */
  async unassignMentor(
    kindergartenId: string,
    groupId: string,
  ): Promise<GroupMentor | null> {
    const group = await this.groups.findById(kindergartenId, groupId);
    if (!group) throw new GroupNotFoundError(groupId);
    return this.groups.unassignMentor(
      kindergartenId,
      groupId,
      this.clock.now(),
    );
  }

  async getActiveMentor(
    kindergartenId: string,
    groupId: string,
  ): Promise<GroupMentor | null> {
    const group = await this.groups.findById(kindergartenId, groupId);
    if (!group) throw new GroupNotFoundError(groupId);
    return this.groups.findActiveMentor(kindergartenId, groupId);
  }

  async getMentorHistory(
    kindergartenId: string,
    groupId: string,
  ): Promise<GroupMentor[]> {
    const group = await this.groups.findById(kindergartenId, groupId);
    if (!group) throw new GroupNotFoundError(groupId);
    return this.groups.listMentorHistory(kindergartenId, groupId);
  }
}
