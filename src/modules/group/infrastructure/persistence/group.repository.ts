import { Group } from '../../domain/entities/group.entity';
import { GroupMentor } from '../../domain/entities/group-mentor.entity';

export interface CreateGroupInput {
  name: string;
  capacity: number;
  ageRangeMin?: number | null;
  ageRangeMax?: number | null;
  currentLocationId?: string | null;
}

export interface UpdateGroupInput {
  name?: string;
  capacity?: number;
  ageRangeMin?: number | null;
  ageRangeMax?: number | null;
  currentLocationId?: string | null;
}

export interface ListGroupsFilters {
  archived?: boolean;
}

/**
 * Port over the groups + group_mentors tables. Mentor history is exposed as
 * a sibling table query — the rich aggregate doesn't try to load every past
 * assignment as part of a single read.
 */
export abstract class GroupRepository {
  abstract create(
    kindergartenId: string,
    input: CreateGroupInput,
  ): Promise<Group>;

  abstract findById(kindergartenId: string, id: string): Promise<Group | null>;

  abstract list(
    kindergartenId: string,
    filters?: ListGroupsFilters,
  ): Promise<Group[]>;

  abstract update(
    kindergartenId: string,
    id: string,
    patch: UpdateGroupInput,
  ): Promise<Group | null>;

  abstract save(group: Group): Promise<Group>;

  // ── group_mentors ──────────────────────────────────────────────────────

  /**
   * Atomically assign a new mentor: in one TX, close the active row (if any)
   * by setting `unassigned_at = now`, then insert a fresh row with
   * `unassigned_at = null`. Surfaces `MentorAlreadyActiveError` on partial
   * unique conflict (race between two concurrent assignments).
   */
  abstract assignMentor(
    kindergartenId: string,
    groupId: string,
    staffMemberId: string,
    now: Date,
  ): Promise<GroupMentor>;

  /**
   * Close the currently active mentor row for the group. Idempotent — if
   * there is no active mentor, returns null without writing.
   */
  abstract unassignMentor(
    kindergartenId: string,
    groupId: string,
    now: Date,
  ): Promise<GroupMentor | null>;

  /**
   * Cascade entry point used by Staff lifecycle actions (deactivate /
   * archive). A staff member can be the active mentor of multiple groups
   * (no DB constraint forbids it — the partial-unique index is keyed on
   * `group_id`, not `staff_member_id`). Closes EVERY currently-active
   * group_mentors row for `(kindergartenId, staffMemberId)` by setting
   * `unassigned_at = now`. Returns the number of rows updated. Idempotent —
   * a no-op (returns 0) when the staff member is not actively mentoring
   * anywhere.
   */
  abstract unassignMentorByStaffMember(
    kindergartenId: string,
    staffMemberId: string,
    now: Date,
  ): Promise<number>;

  abstract findActiveMentor(
    kindergartenId: string,
    groupId: string,
  ): Promise<GroupMentor | null>;

  abstract listMentorHistory(
    kindergartenId: string,
    groupId: string,
  ): Promise<GroupMentor[]>;

  /**
   * Cross-tenant lookup of every currently-active group_mentors row whose
   * `staff_member_id` resolves to a `staff_members` row with the given
   * `user_id`. Used by the WS auto-subscribe handler to enumerate the
   * `group:{gid}` rooms a freshly-connected staff socket should join,
   * regardless of which kindergarten(s) the user staffs.
   *
   * Bypasses RLS via `app.bypass_rls=true` inside its own transaction.
   *
   * When `kindergartenId` is provided, the result is filtered to that
   * single kg — used by WS auto-subscribe to scope rooms to the JWT's
   * `kindergarten_id` claim (a staff member who is also a mentor in
   * another kg must NOT receive that other kg's group events while
   * connected with a kgA-scoped JWT).
   */
  abstract findActiveMentorAssignmentsByUserIdCrossTenant(
    userId: string,
    kindergartenId?: string,
  ): Promise<GroupMentor[]>;

  /**
   * B17 T8 HIGH#3/HIGH#4 — kg-scoped predicate "is this user currently
   * the active mentor of this group?". Joins `group_mentors` with
   * `staff_members` on `staff_member_id` and filters on `user_id` +
   * active assignment (`unassigned_at IS NULL`). Used by
   * `StaffStoriesController` and `StoryService` to enforce that mentor
   * actors can only operate on their own assigned groups.
   *
   * Defaults to `false` so older test fakes compile; the relational impl
   * overrides with a real SQL JOIN.
   */
  isUserActiveMentorForGroup(
    _kindergartenId: string,
    _userId: string,
    _groupId: string,
  ): Promise<boolean> {
    return Promise.resolve(false);
  }
}
