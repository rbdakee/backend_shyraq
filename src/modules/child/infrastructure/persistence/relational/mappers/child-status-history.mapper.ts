import {
  ChildStatusHistory,
  ChildStatusHistoryState,
} from '../../../../domain/entities/child-status-history.entity';
import { ChildStatusHistoryEntity } from '../entities/child-status-history.entity';

export class ChildStatusHistoryMapper {
  static toState(entity: ChildStatusHistoryEntity): ChildStatusHistoryState {
    return {
      id: entity.id,
      kindergartenId: entity.kindergarten_id,
      childId: entity.child_id,
      previousStatus: entity.previous_status,
      newStatus: entity.new_status,
      previousArchiveReason: entity.previous_archive_reason,
      archiveReason: entity.archive_reason,
      changedByUserId: entity.changed_by_user_id,
      changedAt: entity.changed_at,
      createdAt: entity.created_at,
    };
  }

  static toDomain(entity: ChildStatusHistoryEntity): ChildStatusHistory {
    return ChildStatusHistory.hydrate(this.toState(entity));
  }
}
