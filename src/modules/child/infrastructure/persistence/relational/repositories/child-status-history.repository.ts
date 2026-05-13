import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { ChildStatusHistoryState } from '../../../../domain/entities/child-status-history.entity';
import {
  ChildStatusHistoryPage,
  ChildStatusHistoryRepository,
} from '../../child-status-history.repository';
import { ChildStatusHistoryEntity } from '../entities/child-status-history.entity';
import { ChildStatusHistoryMapper } from '../mappers/child-status-history.mapper';

@Injectable()
export class ChildStatusHistoryRelationalRepository extends ChildStatusHistoryRepository {
  constructor(
    @InjectRepository(ChildStatusHistoryEntity)
    private readonly repo: Repository<ChildStatusHistoryEntity>,
  ) {
    super();
  }

  async recordStatusChange(
    kindergartenId: string,
    record: ChildStatusHistoryState,
  ): Promise<void> {
    void kindergartenId; // RLS pins the kg via app.kindergarten_id; the
    // explicit kg arg is for readability + IDE navigation. The row's
    // `kindergarten_id` column is taken from `record.kindergartenId`
    // (which the service builds from the same source).
    const repo = this.manager().getRepository(ChildStatusHistoryEntity);
    await repo.insert({
      id: record.id,
      kindergarten_id: record.kindergartenId,
      child_id: record.childId,
      previous_status: record.previousStatus,
      new_status: record.newStatus,
      previous_archive_reason: record.previousArchiveReason,
      archive_reason: record.archiveReason,
      changed_by_user_id: record.changedByUserId,
      changed_at: record.changedAt,
    });
  }

  async listForChild(
    kindergartenId: string,
    childId: string,
    limit: number,
    offset: number,
  ): Promise<ChildStatusHistoryPage> {
    const repo = this.manager().getRepository(ChildStatusHistoryEntity);
    const qb = repo
      .createQueryBuilder('h')
      .where('h.kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere('h.child_id = :cid', { cid: childId })
      .orderBy('h.changed_at', 'DESC')
      .addOrderBy('h.id', 'DESC') // tie-breaker for rows with the same changed_at
      .skip(offset)
      .take(limit);
    const [rows, total] = await qb.getManyAndCount();
    return {
      items: rows.map((r) => ChildStatusHistoryMapper.toDomain(r)),
      total,
    };
  }

  /**
   * Same fallback logic as the rest of the children/* repos: prefer the
   * tenant TX EntityManager so the INSERT/UPDATE share a transaction
   * (atomic rollback); fall back to the default repo manager only for
   * legacy CLI/integration paths outside an HTTP request.
   */
  private manager(): EntityManager {
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.repo.manager;
  }
}
