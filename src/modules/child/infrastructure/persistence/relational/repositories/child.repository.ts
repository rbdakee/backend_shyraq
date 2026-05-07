import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  In,
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

  /**
   * Cross-tenant batch hydrate by id. Used by IdentityQrService.scan when
   * resolving `linked_children` for a scanned parent — the children may be
   * enrolled in different kindergartens than the scanning staff's tenant,
   * so we bypass RLS for the read. The bypass GUC is set inside a fresh
   * transaction so it does not leak to the caller's request scope.
   *
   * Returns rows in the order PG decides; service callers reorder if needed.
   * No archived-status filter — caller decides whether to surface archived
   * children. Empty input short-circuits without opening a transaction.
   */
  async findByIdsCrossTenant(ids: string[]): Promise<Child[]> {
    if (ids.length === 0) return [];
    return this.dataSource.transaction(async (manager) => {
      await manager.query(`SET LOCAL app.bypass_rls = 'true'`);
      const rows = await manager.getRepository(ChildEntity).find({
        where: { id: In(ids) },
      });
      return rows.map((r) => ChildMapper.toDomain(r));
    });
  }

  // ── B16 — DiscountTargetResolver helpers ──────────────────────────────

  async listAllActiveIdsByKg(kindergartenId: string): Promise<string[]> {
    const rows = (await this.manager().query(
      `SELECT id FROM children
        WHERE kindergarten_id = $1
          AND status <> 'archived'
        ORDER BY id`,
      [kindergartenId],
    )) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  async listActiveIdsByGroupIds(
    kindergartenId: string,
    groupIds: string[],
  ): Promise<string[]> {
    if (groupIds.length === 0) return [];
    const rows = (await this.manager().query(
      `SELECT id FROM children
        WHERE kindergarten_id = $1
          AND status <> 'archived'
          AND current_group_id = ANY($2::uuid[])`,
      [kindergartenId, groupIds],
    )) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  async findActiveIdsInKg(
    kindergartenId: string,
    ids: string[],
  ): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = (await this.manager().query(
      `SELECT id FROM children
        WHERE kindergarten_id = $1
          AND status <> 'archived'
          AND id = ANY($2::uuid[])`,
      [kindergartenId, ids],
    )) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  async listActiveIdsInKgInAgeRange(
    kindergartenId: string,
    fromMonths: number,
    toMonths: number,
    now: Date,
  ): Promise<string[]> {
    // Age in months computed via PG: (year-month diff) on `date_of_birth`
    // anchored to `$2` (now). Inclusive both ends; ages outside the
    // window (negative or undefined) drop out via the BETWEEN guard.
    // Uses age() + extract(year)/12 + extract(month) which truncates to
    // whole months — close enough for B16 catalogue eligibility.
    const rows = (await this.manager().query(
      `SELECT id FROM children
        WHERE kindergarten_id = $1
          AND status <> 'archived'
          AND date_of_birth IS NOT NULL
          AND (
                EXTRACT(YEAR FROM AGE($2::timestamptz, date_of_birth)) * 12
                + EXTRACT(MONTH FROM AGE($2::timestamptz, date_of_birth))
              ) BETWEEN $3 AND $4`,
      [kindergartenId, now, fromMonths, toMonths],
    )) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  private manager(): EntityManager {
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.repo.manager;
  }
}
