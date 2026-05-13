import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { OptimisticLockError } from '@/shared-kernel/domain/errors';
import { formatDateInTimezone } from '@/shared-kernel/domain/value-objects/day-of-week.vo';
import { DiagnosticEntry } from '../../../../domain/entities/diagnostic-entry.entity';
import {
  DiagnosticEntryListResult,
  DiagnosticEntryRepository,
  LatestDiagnosticEntryRow,
  ListDiagnosticEntriesFilter,
} from '../../../../diagnostic-entry.repository';
import { DiagnosticEntryRelationalEntity } from '../entities/diagnostic-entry.entity';
import { DiagnosticEntryMapper } from '../mappers/diagnostic-entry.mapper';

/** See `diagnostic-template.relational-repository.ts` for the rationale. */
function unwrapReturning<T>(raw: unknown): T[] {
  if (Array.isArray(raw) && raw.length === 2 && Array.isArray(raw[0])) {
    return raw[0] as T[];
  }
  if (Array.isArray(raw)) {
    return raw as T[];
  }
  return [];
}

function encodeCursor(assessmentDate: Date, id: string): string {
  return Buffer.from(`${assessmentDate.toISOString()}|${id}`).toString(
    'base64url',
  );
}

function decodeCursor(
  cursor: string,
): { assessmentDate: Date; id: string } | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const [iso, id] = raw.split('|');
    if (!iso || !id) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return { assessmentDate: d, id };
  } catch {
    return null;
  }
}

@Injectable()
export class DiagnosticEntryRelationalRepository extends DiagnosticEntryRepository {
  constructor(
    @InjectRepository(DiagnosticEntryRelationalEntity)
    private readonly repo: Repository<DiagnosticEntryRelationalEntity>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {
    super();
  }

  private manager(): EntityManager {
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.dataSource.manager;
  }

  async create(entry: DiagnosticEntry): Promise<DiagnosticEntry> {
    const m = this.manager();
    const repo = m.getRepository(DiagnosticEntryRelationalEntity);
    const s = entry.toState();
    await m.query(
      `INSERT INTO diagnostic_entries
         (id, kindergarten_id, child_id, template_id, specialist_id,
          assessment_date, data, summary, recommendations, attachments,
          created_at, updated_at, row_version)
       VALUES ($1, $2, $3, $4, $5, $6::date, $7::jsonb, $8, $9, $10,
               $11, $12, $13)`,
      [
        s.id,
        s.kindergartenId,
        s.childId,
        s.templateId,
        s.specialistId,
        formatDateInTimezone(s.assessmentDate),
        JSON.stringify(s.data),
        s.summary,
        s.recommendations,
        s.attachments.length > 0 ? s.attachments : null,
        s.createdAt,
        s.updatedAt,
        s.rowVersion,
      ],
    );
    const persisted = await repo.findOne({
      where: { id: s.id, kindergartenId: s.kindergartenId },
    });
    if (!persisted) {
      throw new Error(`diagnostic_entry_create_lost id=${s.id}`);
    }
    return DiagnosticEntryMapper.toDomain(persisted);
  }

  async findById(kgId: string, id: string): Promise<DiagnosticEntry | null> {
    const row = await this.manager()
      .getRepository(DiagnosticEntryRelationalEntity)
      .findOne({ where: { id, kindergartenId: kgId } });
    return row ? DiagnosticEntryMapper.toDomain(row) : null;
  }

  async update(
    entry: DiagnosticEntry,
    expectedRowVersion?: number,
  ): Promise<DiagnosticEntry> {
    const m = this.manager();
    const s = entry.toState();
    if (expectedRowVersion !== undefined) {
      // B22a T4 — conditional UPDATE with row_version guard. See sibling
      // template repo for the rationale; the entry table follows the
      // same single-statement bump pattern.
      const result = unwrapReturning<{ row_version: number }>(
        await m.query(
          `UPDATE diagnostic_entries
              SET data = $3::jsonb,
                  summary = $4,
                  recommendations = $5,
                  attachments = $6,
                  updated_at = $7,
                  row_version = row_version + 1
            WHERE id = $1
              AND kindergarten_id = $2
              AND row_version = $8
            RETURNING row_version`,
          [
            s.id,
            s.kindergartenId,
            JSON.stringify(s.data),
            s.summary,
            s.recommendations,
            s.attachments.length > 0 ? s.attachments : null,
            s.updatedAt,
            expectedRowVersion,
          ],
        ),
      );
      if (result.length === 0) {
        throw new OptimisticLockError();
      }
      const persisted = await m
        .getRepository(DiagnosticEntryRelationalEntity)
        .findOne({ where: { id: s.id, kindergartenId: s.kindergartenId } });
      if (!persisted) {
        throw new Error(`diagnostic_entry_update_lost id=${s.id}`);
      }
      return DiagnosticEntryMapper.toDomain(persisted);
    }
    await m.getRepository(DiagnosticEntryRelationalEntity).update(
      { id: s.id, kindergartenId: s.kindergartenId },
      {
        // assessment_date is immutable per BP §8.4 — not in the patch.
        // TypeORM's QueryDeepPartialEntity narrows JSONB columns into a
        // recursive partial; for opaque records we cast through unknown.
        data: s.data as unknown as undefined,
        summary: s.summary,
        recommendations: s.recommendations,
        attachments: s.attachments.length > 0 ? s.attachments : null,
        updatedAt: s.updatedAt,
      },
    );
    return entry;
  }

  async list(
    kgId: string,
    filters: ListDiagnosticEntriesFilter,
  ): Promise<DiagnosticEntryListResult> {
    const qb = this.manager()
      .getRepository(DiagnosticEntryRelationalEntity)
      .createQueryBuilder('de')
      .where('de.kindergarten_id = :kg', { kg: kgId });

    if (filters.childId !== undefined) {
      qb.andWhere('de.child_id = :cid', { cid: filters.childId });
    }
    if (filters.specialistId !== undefined) {
      qb.andWhere('de.specialist_id = :sid', { sid: filters.specialistId });
    }
    if (filters.templateId !== undefined) {
      qb.andWhere('de.template_id = :tid', { tid: filters.templateId });
    }
    if (filters.from !== undefined) {
      qb.andWhere('de.assessment_date >= :from', {
        from: formatDateInTimezone(filters.from),
      });
    }
    if (filters.to !== undefined) {
      qb.andWhere('de.assessment_date <= :to', {
        to: formatDateInTimezone(filters.to),
      });
    }
    if (filters.cursor) {
      const decoded = decodeCursor(filters.cursor);
      if (decoded) {
        qb.andWhere('(de.assessment_date, de.id) < (:cursorDate, :cursorId)', {
          cursorDate: formatDateInTimezone(decoded.assessmentDate),
          cursorId: decoded.id,
        });
      }
    }

    qb.orderBy('de.assessment_date', 'DESC')
      .addOrderBy('de.id', 'DESC')
      .limit(filters.limit + 1);

    const rows = await qb.getMany();
    const hasMore = rows.length > filters.limit;
    const trimmed = hasMore ? rows.slice(0, filters.limit) : rows;
    const items = trimmed.map(DiagnosticEntryMapper.toDomain);
    const last = trimmed[trimmed.length - 1];
    const nextCursor =
      hasMore && last ? encodeCursor(last.assessmentDate, last.id) : null;
    return { items, nextCursor };
  }

  async findLatestPerActiveChildBySpecialistType(
    kgId: string,
    specialistType: string,
  ): Promise<Map<string, LatestDiagnosticEntryRow>> {
    // DISTINCT ON returns the first row per (child_id) under the supplied
    // ORDER BY — here `assessment_date DESC, id DESC` so the "newest"
    // assessment wins. JOIN to diagnostic_templates on specialist_type so
    // entries authored under a template not matching the requested
    // specialist_type are excluded.
    const rows = (await this.manager().query(
      `SELECT DISTINCT ON (de.child_id)
              de.child_id      AS child_id,
              de.assessment_date AS assessment_date
         FROM diagnostic_entries de
         JOIN diagnostic_templates dt
           ON dt.id = de.template_id
          AND dt.kindergarten_id = de.kindergarten_id
         JOIN children c
           ON c.id = de.child_id
          AND c.kindergarten_id = de.kindergarten_id
        WHERE de.kindergarten_id = $1
          AND dt.specialist_type = $2
          AND c.status <> 'archived'
        ORDER BY de.child_id, de.assessment_date DESC, de.id DESC`,
      [kgId, specialistType],
    )) as Array<{ child_id: string; assessment_date: string | Date }>;

    const out = new Map<string, LatestDiagnosticEntryRow>();
    for (const r of rows) {
      const date =
        r.assessment_date instanceof Date
          ? r.assessment_date
          : new Date(`${r.assessment_date}T00:00:00.000Z`);
      out.set(r.child_id, { childId: r.child_id, assessmentDate: date });
    }
    return out;
  }
}
