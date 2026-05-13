import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { OptimisticLockError } from '@/shared-kernel/domain/errors';
import { ProgressNote } from '../../../../domain/entities/progress-note.entity';
import {
  ListProgressNotesFilter,
  ProgressNoteListResult,
  ProgressNoteRepository,
} from '../../../../progress-note.repository';
import { ProgressNoteRelationalEntity } from '../entities/progress-note.entity';
import { ProgressNoteMapper } from '../mappers/progress-note.mapper';

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

function encodeCursor(notedAt: Date, id: string): string {
  return Buffer.from(`${notedAt.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { notedAt: Date; id: string } | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const [iso, id] = raw.split('|');
    if (!iso || !id) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return { notedAt: d, id };
  } catch {
    return null;
  }
}

@Injectable()
export class ProgressNoteRelationalRepository extends ProgressNoteRepository {
  constructor(
    @InjectRepository(ProgressNoteRelationalEntity)
    private readonly repo: Repository<ProgressNoteRelationalEntity>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {
    super();
  }

  private manager(): EntityManager {
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.dataSource.manager;
  }

  async create(note: ProgressNote): Promise<ProgressNote> {
    const m = this.manager();
    const repo = m.getRepository(ProgressNoteRelationalEntity);
    const s = note.toState();
    await m.query(
      `INSERT INTO progress_notes
         (id, kindergarten_id, child_id, mentor_id, body, media_urls,
          noted_at, created_at, row_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        s.id,
        s.kindergartenId,
        s.childId,
        s.mentorId,
        s.body,
        s.mediaUrls.length > 0 ? s.mediaUrls : null,
        s.notedAt,
        s.createdAt,
        s.rowVersion,
      ],
    );
    const persisted = await repo.findOne({
      where: { id: s.id, kindergartenId: s.kindergartenId },
    });
    if (!persisted) {
      throw new Error(`progress_note_create_lost id=${s.id}`);
    }
    return ProgressNoteMapper.toDomain(persisted);
  }

  async findById(kgId: string, id: string): Promise<ProgressNote | null> {
    const row = await this.manager()
      .getRepository(ProgressNoteRelationalEntity)
      .findOne({ where: { id, kindergartenId: kgId } });
    return row ? ProgressNoteMapper.toDomain(row) : null;
  }

  async update(
    note: ProgressNote,
    expectedRowVersion?: number,
  ): Promise<ProgressNote> {
    const m = this.manager();
    const s = note.toState();
    if (expectedRowVersion !== undefined) {
      // B22a T4 — conditional UPDATE with row_version guard. The
      // append-only schema has no `updated_at` column, so the only
      // mutated bookkeeping field is `row_version` itself.
      // B22a T7 — also stamps the admin-bypass audit columns.
      const result = unwrapReturning<{ row_version: number }>(
        await m.query(
          `UPDATE progress_notes
              SET body = $3,
                  media_urls = $4,
                  last_modified_by_user_id = $5,
                  last_modified_at = $6,
                  row_version = row_version + 1
            WHERE id = $1
              AND kindergarten_id = $2
              AND row_version = $7
            RETURNING row_version`,
          [
            s.id,
            s.kindergartenId,
            s.body,
            s.mediaUrls.length > 0 ? s.mediaUrls : null,
            s.lastModifiedByUserId ?? null,
            s.lastModifiedAt ?? null,
            expectedRowVersion,
          ],
        ),
      );
      if (result.length === 0) {
        throw new OptimisticLockError();
      }
      const persisted = await m
        .getRepository(ProgressNoteRelationalEntity)
        .findOne({ where: { id: s.id, kindergartenId: s.kindergartenId } });
      if (!persisted) {
        throw new Error(`progress_note_update_lost id=${s.id}`);
      }
      return ProgressNoteMapper.toDomain(persisted);
    }
    // No `updated_at` column on this table — append-only schema.
    await m.getRepository(ProgressNoteRelationalEntity).update(
      { id: s.id, kindergartenId: s.kindergartenId },
      {
        body: s.body,
        mediaUrls: s.mediaUrls.length > 0 ? s.mediaUrls : null,
        lastModifiedByUserId: s.lastModifiedByUserId ?? null,
        lastModifiedAt: s.lastModifiedAt ?? null,
      },
    );
    return note;
  }

  async delete(kgId: string, id: string): Promise<boolean> {
    const result = await this.manager()
      .getRepository(ProgressNoteRelationalEntity)
      .delete({ id, kindergartenId: kgId });
    return (result.affected ?? 0) > 0;
  }

  async list(
    kgId: string,
    filters: ListProgressNotesFilter,
  ): Promise<ProgressNoteListResult> {
    const qb = this.manager()
      .getRepository(ProgressNoteRelationalEntity)
      .createQueryBuilder('pn')
      .where('pn.kindergarten_id = :kg', { kg: kgId });

    if (filters.childId !== undefined) {
      qb.andWhere('pn.child_id = :cid', { cid: filters.childId });
    }
    if (filters.mentorId !== undefined) {
      qb.andWhere('pn.mentor_id = :mid', { mid: filters.mentorId });
    }
    if (filters.from !== undefined) {
      qb.andWhere('pn.noted_at >= :from', { from: filters.from });
    }
    if (filters.to !== undefined) {
      qb.andWhere('pn.noted_at <= :to', { to: filters.to });
    }
    if (filters.cursor) {
      const decoded = decodeCursor(filters.cursor);
      if (decoded) {
        qb.andWhere('(pn.noted_at, pn.id) < (:cursorAt, :cursorId)', {
          cursorAt: decoded.notedAt,
          cursorId: decoded.id,
        });
      }
    }

    qb.orderBy('pn.noted_at', 'DESC')
      .addOrderBy('pn.id', 'DESC')
      .limit(filters.limit + 1);

    const rows = await qb.getMany();
    const hasMore = rows.length > filters.limit;
    const trimmed = hasMore ? rows.slice(0, filters.limit) : rows;
    const items = trimmed.map(ProgressNoteMapper.toDomain);
    const last = trimmed[trimmed.length - 1];
    const nextCursor =
      hasMore && last ? encodeCursor(last.notedAt, last.id) : null;
    return { items, nextCursor };
  }
}
