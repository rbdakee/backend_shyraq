import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  QueryFailedError,
  Repository,
} from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { Child } from '../../../../domain/entities/child.entity';
import { ChildIinAlreadyExistsError } from '../../../../domain/errors/child-iin-already-exists.error';
import {
  ChildGroupHistoryRecord,
  ChildListFilters,
  ChildRepository,
  PageRequest,
  PageResult,
} from '../../child.repository';
import { ChildEntity } from '../entities/child.entity';
import { ChildGroupHistoryEntity } from '../entities/child-group-history.entity';
import { ChildMapper } from '../mappers/child.mapper';
import { ChildGroupHistoryMapper } from '../mappers/child-group-history.mapper';

interface PgUniqueViolation {
  code: string;
  constraint?: string;
}
const PG_UNIQUE_VIOLATION = '23505';

@Injectable()
export class ChildRelationalRepository extends ChildRepository {
  constructor(
    @InjectRepository(ChildEntity)
    private readonly repo: Repository<ChildEntity>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {
    super();
  }

  async create(child: Child): Promise<void> {
    const repo = this.manager().getRepository(ChildEntity);
    const state = child.toState();
    try {
      await repo.insert({
        id: state.id,
        kindergarten_id: state.kindergartenId,
        iin: state.iin,
        full_name: state.fullName,
        date_of_birth: state.dateOfBirth,
        gender: state.gender,
        photo_url: state.photoUrl,
        status: state.status,
        current_group_id: state.currentGroupId,
        enrollment_date: state.enrollmentDate,
        archived_at: state.archivedAt,
        archive_reason: state.archiveReason,
        medical_notes: state.medicalNotes,
        allergy_notes: state.allergyNotes,
      });
    } catch (err) {
      if (err instanceof QueryFailedError) {
        const pg = err.driverError as PgUniqueViolation | undefined;
        if (
          pg?.code === PG_UNIQUE_VIOLATION &&
          pg.constraint === 'idx_children_iin_kindergarten' &&
          state.iin
        ) {
          throw new ChildIinAlreadyExistsError(state.iin);
        }
      }
      throw err;
    }
  }

  async findById(kindergartenId: string, id: string): Promise<Child | null> {
    const row = await this.manager()
      .getRepository(ChildEntity)
      .findOne({ where: { id, kindergarten_id: kindergartenId } });
    return row ? ChildMapper.toDomain(row) : null;
  }

  async findByKindergartenAndIin(
    kindergartenId: string,
    iin: string,
  ): Promise<Child | null> {
    const row = await this.manager()
      .getRepository(ChildEntity)
      .findOne({ where: { kindergarten_id: kindergartenId, iin } });
    return row ? ChildMapper.toDomain(row) : null;
  }

  async update(child: Child): Promise<void> {
    const state = child.toState();
    const repo = this.manager().getRepository(ChildEntity);
    try {
      await repo.update(
        { id: state.id, kindergarten_id: state.kindergartenId },
        {
          iin: state.iin,
          full_name: state.fullName,
          date_of_birth: state.dateOfBirth,
          gender: state.gender,
          photo_url: state.photoUrl,
          status: state.status,
          current_group_id: state.currentGroupId,
          enrollment_date: state.enrollmentDate,
          archived_at: state.archivedAt,
          archive_reason: state.archiveReason,
          medical_notes: state.medicalNotes,
          allergy_notes: state.allergyNotes,
        },
      );
    } catch (err) {
      if (err instanceof QueryFailedError) {
        const pg = err.driverError as PgUniqueViolation | undefined;
        if (
          pg?.code === PG_UNIQUE_VIOLATION &&
          pg.constraint === 'idx_children_iin_kindergarten' &&
          state.iin
        ) {
          throw new ChildIinAlreadyExistsError(state.iin);
        }
      }
      throw err;
    }
  }

  async list(
    kindergartenId: string,
    filters: ChildListFilters,
    page: PageRequest,
  ): Promise<PageResult<Child>> {
    const qb = this.manager()
      .getRepository(ChildEntity)
      .createQueryBuilder('c')
      .where('c.kindergarten_id = :kg', { kg: kindergartenId });

    if (filters.status !== undefined) {
      qb.andWhere('c.status = :status', { status: filters.status });
    }
    if (filters.currentGroupId !== undefined) {
      qb.andWhere('c.current_group_id = :gid', { gid: filters.currentGroupId });
    }
    if (filters.q !== undefined && filters.q.length > 0) {
      qb.andWhere('(c.full_name ILIKE :q OR c.iin ILIKE :q)', {
        q: `%${filters.q}%`,
      });
    }

    qb.orderBy('c.created_at', 'DESC').skip(page.offset).take(page.limit);
    const [rows, total] = await qb.getManyAndCount();
    return {
      items: rows.map((r) => ChildMapper.toDomain(r)),
      total,
    };
  }

  async countActiveByGroup(
    kindergartenId: string,
    groupId: string,
  ): Promise<number> {
    return this.manager()
      .getRepository(ChildEntity)
      .createQueryBuilder('c')
      .where('c.kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere('c.current_group_id = :gid', { gid: groupId })
      .andWhere('c.status = :status', { status: 'active' })
      .getCount();
  }

  async recordGroupTransfer(
    kindergartenId: string,
    childId: string,
    fromGroupId: string | null,
    toGroupId: string,
    transferredByStaffId: string,
    reason: string | null,
    at: Date,
  ): Promise<void> {
    const repo = this.manager().getRepository(ChildGroupHistoryEntity);
    await repo.insert({
      kindergarten_id: kindergartenId,
      child_id: childId,
      from_group_id: fromGroupId,
      to_group_id: toGroupId,
      transferred_by_staff_id: transferredByStaffId,
      reason,
      transferred_at: at,
    });
  }

  async listGroupHistory(
    kindergartenId: string,
    childId: string,
  ): Promise<ChildGroupHistoryRecord[]> {
    const rows = await this.manager()
      .getRepository(ChildGroupHistoryEntity)
      .createQueryBuilder('h')
      .where('h.kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere('h.child_id = :cid', { cid: childId })
      .orderBy('h.transferred_at', 'ASC')
      .getMany();
    return rows.map((r) => ChildGroupHistoryMapper.toRecord(r));
  }

  /**
   * Cross-tenant IIN lookup. Opens a fresh transaction and toggles
   * `app.bypass_rls=true` so RLS does not filter by the ambient
   * `app.kindergarten_id` (which is typically absent on the public
   * `/parent/children/link` route). Excludes archived children. Mirrors the
   * pattern of `ChildGuardianRelationalRepository.listApprovedKindergartenIdsByUserId`.
   */
  async findByIinCrossTenant(iin: string): Promise<Child[]> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query(`SET LOCAL app.bypass_rls = 'true'`);
      const rows = await manager
        .getRepository(ChildEntity)
        .createQueryBuilder('c')
        .where('c.iin = :iin', { iin })
        .andWhere("c.status <> 'archived'")
        .orderBy('c.created_at', 'DESC')
        .getMany();
      return rows.map((r) => ChildMapper.toDomain(r));
    });
  }

  private manager(): EntityManager {
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.repo.manager;
  }
}
