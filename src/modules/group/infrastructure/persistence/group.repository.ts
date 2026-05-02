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
}
