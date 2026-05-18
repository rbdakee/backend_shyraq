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
  ChildArchiveResult,
  ChildGroupHistoryRecord,
  ChildListFilters,
  ChildReactivateResult,
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

  // ── B21 — Lifecycle conditional UPDATEs ────────────────────────────────

  async archive(
    kindergartenId: string,
    childId: string,
    archivedAt: Date,
    archiveReason: string,
  ): Promise<ChildArchiveResult> {
    const m = this.manager().getRepository(ChildEntity);
    const result = await m
      .createQueryBuilder()
      .update(ChildEntity)
      .set({
        status: 'archived',
        archived_at: archivedAt,
        archive_reason: archiveReason,
        updated_at: archivedAt,
      })
      .where('id = :id', { id: childId })
      .andWhere('kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere(`status = 'active'`)
      .returning('*')
      .execute();
    if (result.raw?.length) {
      // Happy path: hydrate the post-mutation row directly from
      // RETURNING * so we make a single SQL round-trip (T8 H5).
      // pg-driver returns column values as already-typed JS objects
      // (Date for timestamptz/date, string for varchar/text, …) so we
      // can feed the raw row through the same mapper used by findOne.
      return {
        kind: 'archived',
        child: ChildMapper.toDomain(this.hydrateRaw(m, result.raw[0])),
      };
    }
    // 0-row UPDATE — disambiguate 409 vs 404 with a single follow-up SELECT.
    const existing = await m.findOne({
      where: { id: childId, kindergarten_id: kindergartenId },
    });
    if (!existing) return { kind: 'not-found' };
    return { kind: 'already-archived' };
  }

  async reactivate(
    kindergartenId: string,
    childId: string,
    reactivatedAt: Date,
  ): Promise<ChildReactivateResult> {
    const m = this.manager().getRepository(ChildEntity);
    const result = await m
      .createQueryBuilder()
      .update(ChildEntity)
      .set({
        status: 'active',
        archived_at: null,
        archive_reason: null,
        updated_at: reactivatedAt,
      })
      .where('id = :id', { id: childId })
      .andWhere('kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere(`status = 'archived'`)
      .returning('*')
      .execute();
    if (result.raw?.length) {
      // Single round-trip hydrate from RETURNING * (T8 H5).
      return {
        kind: 'reactivated',
        child: ChildMapper.toDomain(this.hydrateRaw(m, result.raw[0])),
      };
    }
    const existing = await m.findOne({
      where: { id: childId, kindergarten_id: kindergartenId },
    });
    if (!existing) return { kind: 'not-found' };
    return { kind: 'not-archived' };
  }

  /**
   * Build a `ChildEntity` from the raw `RETURNING *` row produced by the
   * archive/reactivate conditional UPDATEs. node-postgres parses
   * timestamptz columns into JS Dates by default; `date` columns come
   * back as strings, which `ChildMapper.toDomain` already handles. We
   * normalise into a fresh entity instance (not a plain object) so the
   * mapper's `instanceof Date` branches work on the timestamp columns.
   */
  private hydrateRaw(
    repo: Repository<ChildEntity>,
    raw: Record<string, unknown>,
  ): ChildEntity {
    const entity = repo.create();
    Object.assign(entity, raw);
    return entity;
  }

  // ── B22a T3 (FINDINGS B21-T6-M3) — Monthly billing archive-race guard ─

  /**
   * `SELECT 1 FROM children WHERE id = $1 AND kindergarten_id = $2 AND
   *  status <> 'archived' FOR UPDATE` — the row-level lock is the
   * defence against the archive-vs-invoice race surfaced by B21-T6-M3.
   * Returns boolean; the service layer treats `false` as "skip this
   * child this period". Caller must already be inside the ambient TX
   * (the monthly cron's per-kg TX) — `manager()` falls back to the
   * default repo manager only for legacy CLI/testing paths where
   * `FOR UPDATE` would be functionally a no-op.
   */
  async existsActiveByIdForUpdate(
    kindergartenId: string,
    childId: string,
  ): Promise<boolean> {
    const rows = (await this.manager().query(
      `SELECT 1 FROM children
        WHERE id = $1
          AND kindergarten_id = $2
          AND status <> 'archived'
        FOR UPDATE`,
      [childId, kindergartenId],
    )) as Array<unknown>;
    return rows.length > 0;
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

  // ── B17 — Birthday content generator helper ──────────────────────────

  async listActiveByBirthdayMonthDay(
    kindergartenId: string,
    month: number,
    day: number,
  ): Promise<Child[]> {
    const rows = await this.manager()
      .getRepository(ChildEntity)
      .createQueryBuilder('c')
      .where('c.kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere(`c.status <> 'archived'`)
      .andWhere('c.date_of_birth IS NOT NULL')
      .andWhere('EXTRACT(MONTH FROM c.date_of_birth) = :m', { m: month })
      .andWhere('EXTRACT(DAY FROM c.date_of_birth) = :d', { d: day })
      .orderBy('c.id', 'ASC')
      .getMany();
    return rows.map((r) => ChildMapper.toDomain(r));
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

  // ── B18 — MyTodosService helper ──────────────────────────────────────

  async listActiveLightByKg(
    kindergartenId: string,
  ): Promise<Array<{ id: string; fullName: string }>> {
    const rows = (await this.manager().query(
      `SELECT id, full_name
         FROM children
        WHERE kindergarten_id = $1
          AND status <> 'archived'
        ORDER BY full_name ASC, id ASC`,
      [kindergartenId],
    )) as Array<{ id: string; full_name: string }>;
    return rows.map((r) => ({ id: r.id, fullName: r.full_name }));
  }

  // ── B-DASH — Dashboard summary aggregate ──────────────────────────────

  async countActiveByKindergarten(kindergartenId: string): Promise<number> {
    const rows = await this.manager().query(
      `SELECT COUNT(*)::text AS count
         FROM children
        WHERE kindergarten_id = $1
          AND status = 'active'`,
      [kindergartenId],
    );
    return Number(rows?.[0]?.count ?? 0);
  }

  private manager(): EntityManager {
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.repo.manager;
  }
}
