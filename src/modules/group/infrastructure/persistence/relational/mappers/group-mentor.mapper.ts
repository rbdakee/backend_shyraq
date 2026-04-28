import { GroupMentor } from '../../../../domain/entities/group-mentor.entity';
import { GroupMentorEntity } from '../entities/group-mentor.entity';

export class GroupMentorMapper {
  static toDomain(entity: GroupMentorEntity): GroupMentor {
    return GroupMentor.hydrate({
      id: entity.id,
      kindergartenId: entity.kindergarten_id,
      groupId: entity.group_id,
      staffMemberId: entity.staff_member_id,
      isPrimary: entity.is_primary,
      assignedAt: entity.assigned_at,
      unassignedAt: entity.unassigned_at,
      createdAt: entity.created_at,
    });
  }
}
