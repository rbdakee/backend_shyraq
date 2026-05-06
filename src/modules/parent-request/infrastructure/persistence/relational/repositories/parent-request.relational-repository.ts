import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import {
  ParentRequest,
  ParentRequestStatus,
} from '../../../../domain/entities/parent-request.entity';
import {
  CreateParentRequestInput,
  ListParentRequestsFilter,
  ParentRequestRepository,
} from '../../../../parent-request.repository';
import { ParentRequestTypeOrmEntity } from '../entities/parent-request.typeorm.entity';
import { ParentRequestMapper } from '../mappers/parent-request.mapper';

@Injectable()
export class ParentRequestRelationalRepository extends ParentRequestRepository {
  constructor(
    @InjectRepository(ParentRequestTypeOrmEntity)
    private readonly repo: Repository<ParentRequestTypeOrmEntity>,
  ) {
    super();
  }

  /**
   * Returns the EntityManager bound to the active tenant transaction (set by
   * `TenantContextInterceptor`) when present, otherwise falls back to the
   * repository's default pool manager. Mirrors pickup-request pattern.
   */
  private manager(): EntityManager {
    return tenantStorage.getStore()?.entityManager ?? this.repo.manager;
  }

  async create(input: CreateParentRequestInput): Promise<ParentRequest> {
    const m = this.manager();
    const row = m.create(ParentRequestTypeOrmEntity, {
      kindergartenId: input.kindergartenId,
      childId: input.childId,
      requesterUserId: input.requesterUserId,
      requestType: input.requestType,
      status: 'pending',
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      details: input.details,
      recipientType: input.recipientType,
      recipientStaffId: input.recipientStaffId,
    });
    const saved = await m.save(ParentRequestTypeOrmEntity, row);
    return ParentRequestMapper.toDomain(saved);
  }

  async findById(
    id: string,
    kindergartenId: string,
  ): Promise<ParentRequest | null> {
    const m = this.manager();
    const row = await m.findOne(ParentRequestTypeOrmEntity, {
      where: { id, kindergartenId },
    });
    return row ? ParentRequestMapper.toDomain(row) : null;
  }

  async list(filter: ListParentRequestsFilter): Promise<ParentRequest[]> {
    const m = this.manager();
    const qb = m
      .createQueryBuilder(ParentRequestTypeOrmEntity, 'pr')
      .where('pr.kindergartenId = :kgId', { kgId: filter.kindergartenId });

    if (filter.status) {
      qb.andWhere('pr.status = :status', { status: filter.status });
    }
    if (filter.requestType) {
      qb.andWhere('pr.requestType = :type', { type: filter.requestType });
    }
    if (filter.childId) {
      qb.andWhere('pr.childId = :cid', { cid: filter.childId });
    }
    if (filter.requesterUserId) {
      qb.andWhere('pr.requesterUserId = :uid', { uid: filter.requesterUserId });
    }
    if (filter.recipientStaffId) {
      qb.andWhere('pr.recipientStaffId = :rsid', {
        rsid: filter.recipientStaffId,
      });
    }
    if (filter.recipientType) {
      qb.andWhere('pr.recipientType = :rt', { rt: filter.recipientType });
    }

    qb.orderBy('pr.createdAt', 'DESC').addOrderBy('pr.id', 'DESC');

    if (filter.limit) {
      qb.limit(filter.limit);
    }

    const rows = await qb.getMany();
    return rows.map(ParentRequestMapper.toDomain);
  }

  async updateStatusConditional(
    id: string,
    kindergartenId: string,
    expectedStatus: ParentRequestStatus,
    nextStatus: ParentRequestStatus,
    patch: {
      reviewedBy?: string | null;
      reviewedAt?: Date | null;
      reviewNote?: string | null;
      updatedAt: Date;
    },
  ): Promise<ParentRequest | null> {
    const m = this.manager();
    const result = await m
      .createQueryBuilder()
      .update(ParentRequestTypeOrmEntity)
      .set({
        status: nextStatus,
        reviewedBy: patch.reviewedBy ?? null,
        reviewedAt: patch.reviewedAt ?? null,
        reviewNote: patch.reviewNote ?? null,
        updatedAt: patch.updatedAt,
      })
      .where('id = :id', { id })
      .andWhere('kindergartenId = :kgId', { kgId: kindergartenId })
      .andWhere('status = :expected', { expected: expectedStatus })
      .returning('*')
      .execute();

    if (!result.raw?.length) {
      return null;
    }

    // `returning('*')` returns raw DB rows (snake_case column names).
    // We need to do a fresh findById to get a properly hydrated TypeORM entity.
    const row = await m.findOne(ParentRequestTypeOrmEntity, {
      where: { id, kindergartenId },
    });
    return row ? ParentRequestMapper.toDomain(row) : null;
  }
}
