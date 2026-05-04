import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { Enrollment } from '../../../../domain/entities/enrollment.entity';
import { EnrollmentStatusValue } from '../../../../domain/value-objects/enrollment-status.vo';
import {
  EnrollmentListFilter,
  EnrollmentListResult,
  EnrollmentRepository,
} from '../../enrollment.repository';
import { EnrollmentEntity } from '../entities/enrollment.entity';
import { EnrollmentMapper } from '../mappers/enrollment.mapper';

/**
 * TypeORM-backed adapter for `EnrollmentRepository`. Picks the per-request
 * tenant-scoped EntityManager from `tenantStorage` so RLS GUC set by
 * `TenantContextInterceptor` is in scope; falls back to the default
 * connection manager for CLI / integration paths that aren't run through
 * the HTTP pipeline.
 */
@Injectable()
export class EnrollmentRelationalRepository extends EnrollmentRepository {
  constructor(
    @InjectRepository(EnrollmentEntity)
    private readonly repo: Repository<EnrollmentEntity>,
  ) {
    super();
  }

  async create(
    kindergartenId: string,
    enrollment: Enrollment,
  ): Promise<Enrollment> {
    const repo = this.manager().getRepository(EnrollmentEntity);
    const state = enrollment.toState();
    await repo.insert({
      id: state.id,
      kindergarten_id: kindergartenId,
      child_id: state.childId,
      contact_name: state.contactName,
      contact_phone: state.contactPhone,
      child_name: state.childName,
      child_dob: state.childDob,
      child_iin: state.childIin,
      status: state.status,
      source: state.source,
      notes: state.notes,
      assigned_to: state.assignedTo,
      status_changed_at: state.statusChangedAt,
      created_at: state.createdAt,
      updated_at: state.updatedAt,
    });
    const row = await repo.findOne({
      where: { id: state.id, kindergarten_id: kindergartenId },
    });
    if (!row) {
      // Should be impossible — we just inserted under the same RLS scope. If
      // it does happen, it's almost certainly an RLS misconfiguration; let
      // the caller see a clear error rather than a silent null.
      throw new Error(
        `enrollment_create_readback_failed:${state.id}@${kindergartenId}`,
      );
    }
    return EnrollmentMapper.toDomain(row);
  }

  async findById(
    kindergartenId: string,
    enrollmentId: string,
  ): Promise<Enrollment | null> {
    const row = await this.manager()
      .getRepository(EnrollmentEntity)
      .findOne({
        where: { id: enrollmentId, kindergarten_id: kindergartenId },
      });
    return row ? EnrollmentMapper.toDomain(row) : null;
  }

  async update(
    kindergartenId: string,
    enrollment: Enrollment,
  ): Promise<Enrollment> {
    const state = enrollment.toState();
    const repo = this.manager().getRepository(EnrollmentEntity);
    await repo.update(
      { id: state.id, kindergarten_id: kindergartenId },
      {
        child_id: state.childId,
        contact_name: state.contactName,
        contact_phone: state.contactPhone,
        child_name: state.childName,
        child_dob: state.childDob,
        child_iin: state.childIin,
        status: state.status,
        source: state.source,
        notes: state.notes,
        assigned_to: state.assignedTo,
        status_changed_at: state.statusChangedAt,
        updated_at: state.updatedAt,
      },
    );
    const row = await repo.findOne({
      where: { id: state.id, kindergarten_id: kindergartenId },
    });
    if (!row) {
      throw new Error(
        `enrollment_update_readback_failed:${state.id}@${kindergartenId}`,
      );
    }
    return EnrollmentMapper.toDomain(row);
  }

  async updateWithExpectedStatus(
    kindergartenId: string,
    enrollment: Enrollment,
    expectedOldStatus: EnrollmentStatusValue,
  ): Promise<boolean> {
    const m = this.manager();
    const state = enrollment.toState();
    // Conditional UPDATE: only commit when the row's current status still
    // matches `expectedOldStatus`. If a concurrent transition already moved
    // the row, `affected = 0` and the service raises
    // EnrollmentTransitionConflictError to abort the ambient TX.
    const result = await m
      .getRepository(EnrollmentEntity)
      .createQueryBuilder()
      .update(EnrollmentEntity)
      .set({
        child_id: state.childId,
        contact_name: state.contactName,
        contact_phone: state.contactPhone,
        child_name: state.childName,
        child_dob: state.childDob,
        child_iin: state.childIin,
        status: state.status,
        source: state.source,
        notes: state.notes,
        assigned_to: state.assignedTo,
        status_changed_at: state.statusChangedAt,
        updated_at: state.updatedAt,
      })
      .where('id = :id', { id: state.id })
      .andWhere('kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere('status = :expected', { expected: expectedOldStatus })
      .execute();
    return (result.affected ?? 0) > 0;
  }

  async list(
    kindergartenId: string,
    filter: EnrollmentListFilter,
  ): Promise<EnrollmentListResult> {
    const qb = this.manager()
      .getRepository(EnrollmentEntity)
      .createQueryBuilder('e')
      .where('e.kindergarten_id = :kg', { kg: kindergartenId });

    if (filter.status !== undefined) {
      qb.andWhere('e.status = :status', { status: filter.status });
    }
    if (filter.q !== undefined && filter.q.length > 0) {
      // Plan §4.1: substring on child_name (case-insensitive) OR exact on
      // contact_phone. Using two named params lets PG plan each branch
      // independently.
      qb.andWhere('(e.child_name ILIKE :qLike OR e.contact_phone = :qExact)', {
        qLike: `%${filter.q}%`,
        qExact: filter.q,
      });
    }

    const page = filter.page < 1 ? 1 : filter.page;
    const limit = filter.limit < 1 ? 1 : filter.limit;
    qb.orderBy('e.created_at', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    const [rows, total] = await qb.getManyAndCount();
    return {
      items: rows.map((r) => EnrollmentMapper.toDomain(r)),
      total,
    };
  }

  private manager(): EntityManager {
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.repo.manager;
  }
}
