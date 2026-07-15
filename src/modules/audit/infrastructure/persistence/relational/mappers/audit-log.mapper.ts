import { AuditLogEntry } from '../../../../domain/entities/audit-log-entry.entity';
import { AuditLogTypeOrmEntity } from '../entities/audit-log.typeorm.entity';

export class AuditLogMapper {
  static toDomain(row: AuditLogTypeOrmEntity): AuditLogEntry {
    return AuditLogEntry.hydrate({
      id: row.id,
      kindergartenId: row.kindergarten_id,
      entityType: row.entity_type,
      entityId: row.entity_id,
      action: row.action,
      actorUserId: row.actor_user_id,
      actorStaffId: row.actor_staff_id,
      before: row.before,
      after: row.after,
      createdAt:
        row.created_at instanceof Date
          ? row.created_at
          : new Date(row.created_at),
    });
  }
}
