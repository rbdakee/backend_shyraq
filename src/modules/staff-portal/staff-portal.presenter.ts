import { ChildGuardian } from '@/modules/child/domain/entities/child-guardian.entity';
import { ChildCardResponseDto } from './dto/child-card.response.dto';
import { MyGroupResponseDto } from './dto/my-group.response.dto';
import {
  RosterChildResponseDto,
  RosterPageResponseDto,
} from './dto/roster-child.response.dto';
import {
  ChildCardView,
  MyGroupView,
  RosterChildView,
  RosterPageView,
} from './staff-portal.service';

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Formats a group age range for display:
 *   - both bounds  → "4–5 лет" (en-dash U+2013)
 *   - only lower   → "4+ лет"
 *   - only upper / neither → null (an upper-only range has no sensible label)
 */
export function formatAgeRange(
  min: number | null,
  max: number | null,
): string | null {
  if (min !== null && max !== null) return `${min}–${max} лет`;
  if (min !== null) return `${min}+ лет`;
  return null;
}

export class StaffPortalPresenter {
  static myGroup(view: MyGroupView): MyGroupResponseDto {
    return {
      id: view.id,
      name: view.name,
      age_range: formatAgeRange(view.ageRangeMin, view.ageRangeMax),
      room: view.room,
      is_primary: view.isPrimary,
      children_count: view.childrenCount,
    };
  }

  static myGroups(views: MyGroupView[]): MyGroupResponseDto[] {
    return views.map((v) => StaffPortalPresenter.myGroup(v));
  }

  static rosterChild(view: RosterChildView): RosterChildResponseDto {
    const state = view.child.toState();
    return {
      id: state.id,
      full_name: state.fullName,
      date_of_birth: toIsoDate(state.dateOfBirth),
      photo_url: state.photoUrl,
      current_group_id: state.currentGroupId,
      day_status: view.dayStatus,
    };
  }

  static rosterPage(view: RosterPageView): RosterPageResponseDto {
    return {
      items: view.items.map((i) => StaffPortalPresenter.rosterChild(i)),
      next_cursor: view.nextCursor,
    };
  }

  static childCard(view: ChildCardView): ChildCardResponseDto {
    const state = view.child.toState();
    return {
      id: state.id,
      full_name: state.fullName,
      date_of_birth: toIsoDate(state.dateOfBirth),
      photo_url: state.photoUrl,
      current_group_id: state.currentGroupId,
      group_name: view.groupName,
      // Free-text allergy_notes wrapped into a single-element array per the
      // mobile contract; empty array when unset.
      allergies: state.allergyNotes ? [state.allergyNotes] : [],
      medical_notes: state.medicalNotes,
      guardians: view.guardians.map((g) =>
        StaffPortalPresenter.guardian(g.guardian, g.fullName, g.phone),
      ),
    };
  }

  private static guardian(
    guardian: ChildGuardian,
    fullName: string | null,
    phone: string | null,
  ): ChildCardResponseDto['guardians'][number] {
    const state = guardian.toState();
    return {
      user_id: state.userId,
      full_name: fullName,
      // role → relation: the DB has no familial-relation field.
      relation: state.role,
      phone,
      can_pickup: state.canPickup,
    };
  }
}
