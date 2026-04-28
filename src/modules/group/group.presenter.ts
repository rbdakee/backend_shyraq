import { Group } from './domain/entities/group.entity';
import { GroupMentor } from './domain/entities/group-mentor.entity';
import { GroupDto, GroupMentorDto } from './dto/group-response.dto';

export class GroupPresenter {
  static group(group: Group): GroupDto {
    const s = group.toState();
    return {
      id: s.id,
      kindergarten_id: s.kindergartenId,
      name: s.name,
      capacity: s.capacity,
      age_range_min: s.ageRangeMin,
      age_range_max: s.ageRangeMax,
      current_location_id: s.currentLocationId,
      archived_at: s.archivedAt ? s.archivedAt.toISOString() : null,
      created_at: s.createdAt.toISOString(),
      updated_at: s.updatedAt.toISOString(),
    };
  }

  static mentor(mentor: GroupMentor): GroupMentorDto {
    const s = mentor.toState();
    return {
      id: s.id,
      kindergarten_id: s.kindergartenId,
      group_id: s.groupId,
      staff_member_id: s.staffMemberId,
      is_primary: s.isPrimary,
      assigned_at: s.assignedAt.toISOString(),
      unassigned_at: s.unassignedAt ? s.unassignedAt.toISOString() : null,
      created_at: s.createdAt.toISOString(),
    };
  }
}
