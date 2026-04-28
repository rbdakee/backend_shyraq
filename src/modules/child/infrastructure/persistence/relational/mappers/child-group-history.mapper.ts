import { ChildGroupHistoryRecord } from '../../../../child.repository';
import { ChildGroupHistoryEntity } from '../entities/child-group-history.entity';

export class ChildGroupHistoryMapper {
  static toRecord(entity: ChildGroupHistoryEntity): ChildGroupHistoryRecord {
    return {
      id: entity.id,
      childId: entity.child_id,
      fromGroupId: entity.from_group_id,
      toGroupId: entity.to_group_id,
      transferredAt: entity.transferred_at,
      transferredByStaffId: entity.transferred_by_staff_id,
      reason: entity.reason,
    };
  }
}
