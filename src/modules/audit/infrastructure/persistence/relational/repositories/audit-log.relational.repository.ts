import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import {
  AuditEntityType,
  AuditLogEntry,
} from '../../../../domain/entities/audit-log-entry.entity';
import {
  AuditLogRepository,
  ListAuditLogByEntityOptions,
} from '../../audit-log.repository';
import { AuditLogTypeOrmEntity } from '../entities/audit-log.typeorm.entity';
import { AuditLogMapper } from '../mappers/audit-log.mapper';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

@Injectable()
export class AuditLogRelationalRepository extends AuditLogRepository {
  constructor(
    @InjectRepository(AuditLogTypeOrmEntity)
    private readonly repo: Repository<AuditLogTypeOrmEntity>,
  ) {
    super();
  }

  async create(
    kindergartenId: string,
    entry: AuditLogEntry,
  ): Promise<AuditLogEntry> {
    const m = this.manager();
    const state = entry.toState();
    await m.getRepository(AuditLogTypeOrmEntity).insert({
      id: state.id,
      kindergarten_id: kindergartenId,
      entity_type: state.entityType,
      entity_id: state.entityId,
      action: state.action,
      actor_user_id: state.actorUserId,
      actor_staff_id: state.actorStaffId,
      // jsonb columns — TypeORM's QueryDeepPartial type requires a cast.
      before: state.before as unknown as undefined,
      after: state.after as unknown as undefined,
      created_at: state.createdAt,
    });
    const row = await m.getRepository(AuditLogTypeOrmEntity).findOne({
      where: { id: state.id, kindergarten_id: kindergartenId },
    });
    if (!row) {
      throw new Error(
        `audit_log_create_readback_failed:${state.id}@${kindergartenId}`,
      );
    }
    return AuditLogMapper.toDomain(row);
  }

  async listByEntity(
    kindergartenId: string,
    entityType: AuditEntityType,
    entityId: string,
    opts: ListAuditLogByEntityOptions,
  ): Promise<AuditLogEntry[]> {
    const qb = this.manager()
      .getRepository(AuditLogTypeOrmEntity)
      .createQueryBuilder('a')
      .where('a.kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere('a.entity_type = :et', { et: entityType })
      .andWhere('a.entity_id = :eid', { eid: entityId });
    // `a.id` tiebreaks entries written in the same transaction, which share a
    // created_at to the microsecond — without it the page order is arbitrary
    // and rows can repeat or vanish across offsets.
    qb.orderBy('a.created_at', 'DESC').addOrderBy('a.id', 'DESC');
    qb.limit(clampLimit(opts.limit));
    qb.offset(opts.offset ?? 0);
    const rows = await qb.getMany();
    return rows.map((r) => AuditLogMapper.toDomain(r));
  }

  private manager(): EntityManager {
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.repo.manager;
  }
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  if (raw <= 0) return DEFAULT_LIMIT;
  return Math.min(raw, MAX_LIMIT);
}
