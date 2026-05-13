import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { OptimisticLockError } from '@/shared-kernel/domain/errors';
import { DiagnosticTemplate } from '../../../../domain/entities/diagnostic-template.entity';
import {
  DiagnosticTemplateListResult,
  DiagnosticTemplateRepository,
  ListDiagnosticTemplatesFilter,
} from '../../../../diagnostic-template.repository';
import { DiagnosticTemplateRelationalEntity } from '../entities/diagnostic-template.entity';
import { DiagnosticTemplateMapper } from '../mappers/diagnostic-template.mapper';

/**
 * TypeORM 0.3 returns `[rows, rowCount]` for `manager.query()` against
 * `UPDATE … RETURNING` (matches B22a T1 ripple in custom-discount /
 * invoice repos). Treating the tuple as `Array<row>` makes `length`
 * always 2, hiding the cap check. This helper detects the tuple form
 * and returns just the rows half.
 */
function unwrapReturning<T>(raw: unknown): T[] {
  if (Array.isArray(raw) && raw.length === 2 && Array.isArray(raw[0])) {
    return raw[0] as T[];
  }
  if (Array.isArray(raw)) {
    return raw as T[];
  }
  return [];
}

function encodeCursor(updatedAt: Date, id: string): string {
  return Buffer.from(`${updatedAt.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { updatedAt: Date; id: string } | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const [iso, id] = raw.split('|');
    if (!iso || !id) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return { updatedAt: d, id };
  } catch {
    return null;
  }
}

@Injectable()
export class DiagnosticTemplateRelationalRepository extends DiagnosticTemplateRepository {
  constructor(
    @InjectRepository(DiagnosticTemplateRelationalEntity)
    private readonly repo: Repository<DiagnosticTemplateRelationalEntity>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {
    super();
  }

  /**
   * Working manager: ambient `tenantStorage` (HTTP/cron) wins, then we fall
   * back to the default pool manager — used by CLI scripts and integration
   * tests outside the HTTP pipeline.
   */
  private manager(): EntityManager {
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.dataSource.manager;
  }

  async create(template: DiagnosticTemplate): Promise<DiagnosticTemplate> {
    const m = this.manager();
    const repo = m.getRepository(DiagnosticTemplateRelationalEntity);
    const s = template.toState();
    // Raw INSERT to round-trip the JSONB schema cleanly (mirrors the B16
    // / B17 pattern; typed `repo.insert` is awkward with `Record<string,
    // unknown>` JSONB columns). `row_version` is bound explicitly so the
    // freshly persisted aggregate carries the same value the caller will
    // see on `findById` — the column DEFAULT (1) is only a fallback for
    // legacy rows backfilled by the migration.
    await m.query(
      `INSERT INTO diagnostic_templates
         (id, kindergarten_id, specialist_type, name, description, version,
          row_version, is_active, schema, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)`,
      [
        s.id,
        s.kindergartenId,
        s.specialistType,
        s.name,
        s.description,
        s.version,
        s.rowVersion,
        s.isActive,
        JSON.stringify(s.schema),
        s.createdBy,
        s.createdAt,
        s.updatedAt,
      ],
    );
    const persisted = await repo.findOne({
      where: { id: s.id, kindergartenId: s.kindergartenId },
    });
    if (!persisted) {
      throw new Error(`diagnostic_template_create_lost id=${s.id}`);
    }
    return DiagnosticTemplateMapper.toDomain(persisted);
  }

  async findById(kgId: string, id: string): Promise<DiagnosticTemplate | null> {
    const row = await this.manager()
      .getRepository(DiagnosticTemplateRelationalEntity)
      .findOne({ where: { id, kindergartenId: kgId } });
    return row ? DiagnosticTemplateMapper.toDomain(row) : null;
  }

  /**
   * Batch lookup (B22b T5 / B18 M6 — N+1 closure). Issues a single
   * `WHERE id = ANY($2)` keyed by the supplied UUID list, scoped to
   * `kindergarten_id = $1`. PG handles the empty-array case correctly
   * (`ANY('{}')` matches zero rows), but we short-circuit anyway to
   * avoid a wasted round-trip when callers pass `[]`.
   *
   * De-duplicating the input list is the caller's responsibility — the
   * presenters already `[...new Set(...)]` so we don't double the work.
   */
  async listByIds(
    kgId: string,
    ids: string[],
  ): Promise<Map<string, DiagnosticTemplate>> {
    const map = new Map<string, DiagnosticTemplate>();
    if (ids.length === 0) {
      return map;
    }
    const rows = await this.manager()
      .getRepository(DiagnosticTemplateRelationalEntity)
      .createQueryBuilder('dt')
      .where('dt.kindergarten_id = :kg', { kg: kgId })
      .andWhere('dt.id = ANY(:ids)', { ids })
      .getMany();
    for (const row of rows) {
      map.set(row.id, DiagnosticTemplateMapper.toDomain(row));
    }
    return map;
  }

  async findByIdForUpdate(
    kgId: string,
    id: string,
  ): Promise<DiagnosticTemplate | null> {
    const row = await this.manager()
      .getRepository(DiagnosticTemplateRelationalEntity)
      .createQueryBuilder('dt')
      .where('dt.id = :id', { id })
      .andWhere('dt.kindergarten_id = :kg', { kg: kgId })
      .setLock('pessimistic_write')
      .getOne();
    return row ? DiagnosticTemplateMapper.toDomain(row) : null;
  }

  async update(
    template: DiagnosticTemplate,
    expectedRowVersion?: number,
  ): Promise<DiagnosticTemplate> {
    const m = this.manager();
    const s = template.toState();
    if (expectedRowVersion !== undefined) {
      // B22a T4 — conditional UPDATE for optimistic-lock race protection.
      // PostgreSQL evaluates the WHERE under row-locking semantics:
      // concurrent writers serialise on the row, but only the first
      // one whose `row_version = $expected` matches succeeds. Late
      // writers see 0 affected rows → `OptimisticLockError`.
      //
      // `row_version = row_version + 1` keeps the bump deterministic
      // and matches our raw-SQL persistence pattern (we deliberately
      // avoid TypeORM's `@VersionColumn()` magic).
      const result = unwrapReturning<{ row_version: number }>(
        await m.query(
          `UPDATE diagnostic_templates
              SET name = $3,
                  description = $4,
                  version = $5,
                  is_active = $6,
                  schema = $7::jsonb,
                  updated_at = $8,
                  row_version = row_version + 1
            WHERE id = $1
              AND kindergarten_id = $2
              AND row_version = $9
            RETURNING row_version`,
          [
            s.id,
            s.kindergartenId,
            s.name,
            s.description,
            s.version,
            s.isActive,
            JSON.stringify(s.schema),
            s.updatedAt,
            expectedRowVersion,
          ],
        ),
      );
      if (result.length === 0) {
        throw new OptimisticLockError();
      }
      // Re-hydrate from DB so the returned aggregate reflects the freshly
      // bumped `row_version`. We could short-circuit by mutating the
      // state in place, but a fresh read is robust against future
      // trigger-driven columns (e.g. updated_at via DB trigger).
      const persisted = await m
        .getRepository(DiagnosticTemplateRelationalEntity)
        .findOne({ where: { id: s.id, kindergartenId: s.kindergartenId } });
      if (!persisted) {
        // Should be unreachable — RETURNING just confirmed the row.
        throw new Error(`diagnostic_template_update_lost id=${s.id}`);
      }
      return DiagnosticTemplateMapper.toDomain(persisted);
    }
    // Unconditional path retained for callers that explicitly opt out
    // of race protection (e.g. internal cron flows). Service.update()
    // always supplies `expectedRowVersion` after B22a T4.
    await m.getRepository(DiagnosticTemplateRelationalEntity).update(
      { id: s.id, kindergartenId: s.kindergartenId },
      {
        name: s.name,
        description: s.description,
        version: s.version,
        isActive: s.isActive,
        schema: s.schema as unknown as undefined,
        updatedAt: s.updatedAt,
      },
    );
    return template;
  }

  async list(
    kgId: string,
    filters: ListDiagnosticTemplatesFilter,
  ): Promise<DiagnosticTemplateListResult> {
    const qb = this.manager()
      .getRepository(DiagnosticTemplateRelationalEntity)
      .createQueryBuilder('dt')
      .where('dt.kindergarten_id = :kg', { kg: kgId });

    if (filters.specialistType !== undefined) {
      qb.andWhere('dt.specialist_type = :st', { st: filters.specialistType });
    }
    if (filters.isActive !== undefined) {
      qb.andWhere('dt.is_active = :ia', { ia: filters.isActive });
    }
    if (filters.cursor) {
      const decoded = decodeCursor(filters.cursor);
      if (decoded) {
        qb.andWhere('(dt.updated_at, dt.id) < (:cursorUpdatedAt, :cursorId)', {
          cursorUpdatedAt: decoded.updatedAt,
          cursorId: decoded.id,
        });
      }
    }

    qb.orderBy('dt.updated_at', 'DESC')
      .addOrderBy('dt.id', 'DESC')
      // Read one extra row so we can detect "more" without a COUNT.
      .limit(filters.limit + 1);

    const rows = await qb.getMany();
    const hasMore = rows.length > filters.limit;
    const trimmed = hasMore ? rows.slice(0, filters.limit) : rows;
    const items = trimmed.map(DiagnosticTemplateMapper.toDomain);
    const last = trimmed[trimmed.length - 1];
    const nextCursor =
      hasMore && last ? encodeCursor(last.updatedAt, last.id) : null;
    return { items, nextCursor };
  }

  /**
   * H12 (B22a T7) — schema PATCH guard. A scalar `count(*)` is cheap
   * because `diagnostic_entries(template_id, kindergarten_id)` is
   * indirectly indexed via the existing `idx_diagnostic_entries_kg_date`
   * (kg_id) plus the FK index PG creates on `template_id`. We don't need
   * a stricter index — schema PATCHes are rare administrative actions.
   */
  async countEntriesUsingTemplate(
    kgId: string,
    templateId: string,
  ): Promise<number> {
    const rows = (await this.manager().query(
      `SELECT COUNT(*)::int AS count
         FROM diagnostic_entries
        WHERE kindergarten_id = $1
          AND template_id = $2`,
      [kgId, templateId],
    )) as Array<{ count: number }>;
    return rows[0]?.count ?? 0;
  }
}
