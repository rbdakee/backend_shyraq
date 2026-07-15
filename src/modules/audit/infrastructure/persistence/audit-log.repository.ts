import {
  AuditEntityType,
  AuditLogEntry,
} from '../../domain/entities/audit-log-entry.entity';

export interface ListAuditLogByEntityOptions {
  limit?: number;
  offset?: number;
}

/**
 * Port over the append-only `audit_log` table. Implementations are tenant-aware
 * via `tenantStorage`; every method takes an explicit `kindergartenId` (RLS is
 * the second line of defense).
 *
 * There is no `update` / `delete` on purpose — the trail is append-only.
 */
export abstract class AuditLogRepository {
  abstract create(
    kindergartenId: string,
    entry: AuditLogEntry,
  ): Promise<AuditLogEntry>;

  /** Newest first (created_at DESC). */
  abstract listByEntity(
    kindergartenId: string,
    entityType: AuditEntityType,
    entityId: string,
    opts: ListAuditLogByEntityOptions,
  ): Promise<AuditLogEntry[]>;
}
