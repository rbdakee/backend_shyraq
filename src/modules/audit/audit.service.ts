import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import {
  AuditAction,
  AuditEntityType,
  AuditLogEntry,
  AuditSnapshot,
} from './domain/entities/audit-log-entry.entity';
import {
  AuditLogRepository,
  ListAuditLogByEntityOptions,
} from './infrastructure/persistence/audit-log.repository';

export interface RecordAuditInput {
  kindergartenId: string;
  entityType: AuditEntityType;
  entityId: string;
  action: AuditAction;
  actorUserId?: string | null;
  actorStaffId?: string | null;
  before?: AuditSnapshot | null;
  after?: AuditSnapshot | null;
}

/**
 * AuditService — append-only mutation trail over `audit_log`.
 *
 * The write deliberately does NOT open its own transaction. Callers invoke
 * `record` from inside their own business transaction — which, on the HTTP path,
 * is the ambient one opened by `TenantContextInterceptor` and picked up by the
 * repository's `manager()` helper. That is what makes the audit row atomic with
 * the mutation it describes: if the business write rolls back, so does its audit
 * entry, and the trail can never claim something that did not happen.
 */
@Injectable()
export class AuditService {
  constructor(
    private readonly auditLogRepository: AuditLogRepository,
    private readonly clock: ClockPort,
  ) {}

  /**
   * Appends one entry. `createdAt` comes from ClockPort rather than the DB
   * default so the value is deterministic in tests and consistent with the
   * timestamps the calling service stamped on the row it just mutated.
   */
  async record(input: RecordAuditInput): Promise<AuditLogEntry> {
    const entry = AuditLogEntry.create({
      id: randomUUID(),
      kindergartenId: input.kindergartenId,
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      actorUserId: input.actorUserId ?? null,
      actorStaffId: input.actorStaffId ?? null,
      before: input.before ?? null,
      after: input.after ?? null,
      createdAt: this.clock.now(),
    });
    return this.auditLogRepository.create(input.kindergartenId, entry);
  }

  /** History for one entity, newest first. */
  async listByEntity(
    kindergartenId: string,
    entityType: AuditEntityType,
    entityId: string,
    opts: ListAuditLogByEntityOptions = {},
  ): Promise<AuditLogEntry[]> {
    return this.auditLogRepository.listByEntity(
      kindergartenId,
      entityType,
      entityId,
      opts,
    );
  }
}
