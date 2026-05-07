import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { DiagnosticTemplate } from '../../../../domain/entities/diagnostic-template.entity';
import {
  DiagnosticTemplateListResult,
  DiagnosticTemplateRepository,
  ListDiagnosticTemplatesFilter,
} from '../../../../diagnostic-template.repository';
import { DiagnosticTemplateRelationalEntity } from '../entities/diagnostic-template.entity';
import { DiagnosticTemplateMapper } from '../mappers/diagnostic-template.mapper';

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
    // unknown>` JSONB columns).
    await m.query(
      `INSERT INTO diagnostic_templates
         (id, kindergarten_id, specialist_type, name, description, version,
          is_active, schema, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)`,
      [
        s.id,
        s.kindergartenId,
        s.specialistType,
        s.name,
        s.description,
        s.version,
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
    expectedVersion?: number,
  ): Promise<DiagnosticTemplate> {
    const m = this.manager();
    const s = template.toState();
    if (expectedVersion !== undefined) {
      // Conditional UPDATE — race protection. Caller decides what to do
      // when zero rows match (typically: re-read and 409 to the user).
      await m
        .createQueryBuilder()
        .update(DiagnosticTemplateRelationalEntity)
        .set({
          name: s.name,
          description: s.description,
          version: s.version,
          isActive: s.isActive,
          // TypeORM's QueryDeepPartialEntity narrows JSONB columns into a
          // recursive partial; for opaque schemas we cast through unknown.
          schema: s.schema as unknown as undefined,
          updatedAt: s.updatedAt,
        })
        .where('id = :id', { id: s.id })
        .andWhere('kindergarten_id = :kg', { kg: s.kindergartenId })
        .andWhere('version = :ev', { ev: expectedVersion })
        .execute();
    } else {
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
    }
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
}
