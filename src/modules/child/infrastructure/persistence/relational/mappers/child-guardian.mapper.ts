import { ChildGuardian } from '../../../../domain/entities/child-guardian.entity';
import { ChildGuardianEntity } from '../entities/child-guardian.entity';

export class ChildGuardianMapper {
  static toDomain(entity: ChildGuardianEntity): ChildGuardian {
    return ChildGuardian.hydrate({
      id: entity.id,
      kindergartenId: entity.kindergarten_id,
      childId: entity.child_id,
      userId: entity.user_id,
      role: entity.role,
      status: entity.status,
      hasApprovalRights: entity.has_approval_rights,
      approvedBy: entity.approved_by,
      approvedAt: entity.approved_at,
      revokedBy: entity.revoked_by,
      revokedAt: entity.revoked_at,
      canPickup: entity.can_pickup,
      permissions: entity.permissions ?? {},
      permissionsUpdatedBy: entity.permissions_updated_by,
      permissionsUpdatedAt: entity.permissions_updated_at,
      createdAt: entity.created_at,
      updatedAt: entity.updated_at,
    });
  }
}
