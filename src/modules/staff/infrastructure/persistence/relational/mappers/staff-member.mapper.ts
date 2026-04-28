import {
  StaffMember,
  StaffRole,
} from '../../../../domain/entities/staff-member.entity';
import { StaffMemberEntity } from '../entities/staff-member.entity';

export class StaffMemberMapper {
  static toDomain(entity: StaffMemberEntity): StaffMember {
    return StaffMember.hydrate({
      id: entity.id,
      kindergartenId: entity.kindergarten_id,
      userId: entity.user_id,
      role: entity.role as StaffRole,
      specialistType: entity.specialist_type,
      isActive: entity.is_active,
      hiredAt: entity.hired_at !== null ? new Date(entity.hired_at) : null,
      firedAt: entity.fired_at !== null ? new Date(entity.fired_at) : null,
      createdAt: entity.created_at,
      updatedAt: entity.updated_at,
    });
  }
}
