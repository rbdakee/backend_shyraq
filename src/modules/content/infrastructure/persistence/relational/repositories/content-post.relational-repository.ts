import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import {
  ContentPost,
  ContentStatus,
} from '../../../../domain/entities/content-post.entity';
import {
  ContentRepository,
  ListContentFilters,
  TransitionStatusPatch,
} from '../../../../content.repository';
import { ContentPostRelationalEntity } from '../entities/content-post.relational-entity';
import { ContentPostMapper } from '../mappers/content-post.mapper';

@Injectable()
export class ContentPostRelationalRepository extends ContentRepository {
  constructor(
    @InjectRepository(ContentPostRelationalEntity)
    private readonly repo: Repository<ContentPostRelationalEntity>,
  ) {
    super();
  }

  async create(post: ContentPost): Promise<ContentPost> {
    const m = this.manager().getRepository(ContentPostRelationalEntity);
    const row = ContentPostMapper.toRelational(post);
    // TypeORM's _QueryDeepPartialEntity narrows JSONB columns awkwardly
    // (it expects `Record<string, _QueryDeepPartialEntity<unknown>>` for
    // `Record<string, unknown>` JSONB fields). The raw row is the correct
    // shape — cast through unknown to bypass the deep-partial narrow.
    await m.insert(row as unknown as Parameters<typeof m.insert>[0]);
    return post;
  }

  async update(post: ContentPost): Promise<ContentPost> {
    const m = this.manager().getRepository(ContentPostRelationalEntity);
    const s = post.toState();
    const patch: Record<string, unknown> = {
      target_type: s.targetType,
      target_group_id: s.targetGroupId,
      target_child_id: s.targetChildId,
      title: s.title,
      body: s.body,
      title_i18n: s.titleI18n,
      body_i18n: s.bodyI18n,
      media_urls: s.mediaUrls,
      metadata: s.metadata,
      scheduled_for: s.scheduledFor,
      published_at: s.publishedAt,
      expires_at: s.expiresAt,
      status: s.status,
      updated_at: s.updatedAt,
    };
    await m.update(
      { id: s.id, kindergarten_id: s.kindergartenId },
      patch as Parameters<typeof m.update>[1],
    );
    return post;
  }

  async delete(kindergartenId: string, id: string): Promise<boolean> {
    const m = this.manager().getRepository(ContentPostRelationalEntity);
    const result = await m.delete({ id, kindergarten_id: kindergartenId });
    return (result.affected ?? 0) > 0;
  }

  async findById(
    kindergartenId: string,
    id: string,
  ): Promise<ContentPost | null> {
    const row = await this.manager()
      .getRepository(ContentPostRelationalEntity)
      .findOne({ where: { id, kindergarten_id: kindergartenId } });
    return row ? ContentPostMapper.toDomain(row) : null;
  }

  async list(
    kindergartenId: string,
    filters: ListContentFilters,
  ): Promise<ContentPost[]> {
    const qb = this.manager()
      .getRepository(ContentPostRelationalEntity)
      .createQueryBuilder('p')
      .where('p.kindergarten_id = :kg', { kg: kindergartenId });

    if (filters.contentType !== undefined) {
      qb.andWhere('p.content_type = :ct', { ct: filters.contentType });
    }
    if (filters.status !== undefined) {
      qb.andWhere('p.status = :st', { st: filters.status });
    }
    if (filters.targetType !== undefined) {
      qb.andWhere('p.target_type = :tt', { tt: filters.targetType });
    }
    if (filters.targetGroupId !== undefined) {
      qb.andWhere('p.target_group_id = :tgid', {
        tgid: filters.targetGroupId,
      });
    }
    if (filters.targetChildId !== undefined) {
      qb.andWhere('p.target_child_id = :tcid', {
        tcid: filters.targetChildId,
      });
    }
    if (filters.scheduledFrom !== undefined) {
      qb.andWhere('p.scheduled_for >= :sf', { sf: filters.scheduledFrom });
    }
    if (filters.scheduledTo !== undefined) {
      qb.andWhere('p.scheduled_for <= :st2', { st2: filters.scheduledTo });
    }
    if (filters.publishedFrom !== undefined) {
      qb.andWhere('p.published_at >= :pf', { pf: filters.publishedFrom });
    }
    if (filters.publishedTo !== undefined) {
      qb.andWhere('p.published_at <= :pt', { pt: filters.publishedTo });
    }

    // Keyset pagination by (created_at DESC, id DESC). Cursor — when set —
    // skips rows whose (created_at, id) is lexicographically <= the cursor.
    if (
      filters.cursorCreatedAt !== undefined &&
      filters.cursorId !== undefined
    ) {
      qb.andWhere('(p.created_at, p.id) < (:cursorCreatedAt, :cursorId)', {
        cursorCreatedAt: filters.cursorCreatedAt,
        cursorId: filters.cursorId,
      });
    }

    qb.orderBy('p.created_at', 'DESC').addOrderBy('p.id', 'DESC');
    const limit = filters.limit && filters.limit > 0 ? filters.limit : 50;
    qb.take(limit);

    const rows = await qb.getMany();
    return rows.map((r) => ContentPostMapper.toDomain(r));
  }

  async transitionStatus(
    kindergartenId: string,
    id: string,
    expectedStatus: ContentStatus,
    newStatus: ContentStatus,
    patch: TransitionStatusPatch,
  ): Promise<ContentPost | null> {
    const m = this.manager();
    // Build dynamic SET clause — `RETURNING *` returns the post-update row.
    const setClauses: string[] = ['status = $4', 'updated_at = $5'];
    const params: unknown[] = [
      id,
      kindergartenId,
      expectedStatus,
      newStatus,
      patch.updatedAt,
    ];
    let nextIdx = 6;
    if (patch.publishedAt !== undefined) {
      setClauses.push(`published_at = $${nextIdx}`);
      params.push(patch.publishedAt);
      nextIdx += 1;
    }
    if (patch.scheduledFor !== undefined) {
      setClauses.push(`scheduled_for = $${nextIdx}`);
      params.push(patch.scheduledFor);
      nextIdx += 1;
    }

    const sql = `
      UPDATE content_posts
         SET ${setClauses.join(', ')}
       WHERE id = $1
         AND kindergarten_id = $2
         AND status = $3
       RETURNING *
    `;

    const rows = (await m.query(sql, params)) as unknown[];
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const raw = rows[0] as Record<string, unknown>;
    const e = new ContentPostRelationalEntity();
    e.id = raw.id as string;
    e.kindergarten_id = raw.kindergarten_id as string;
    e.content_type =
      raw.content_type as ContentPostRelationalEntity['content_type'];
    e.target_type =
      raw.target_type as ContentPostRelationalEntity['target_type'];
    e.target_group_id = (raw.target_group_id as string | null) ?? null;
    e.target_child_id = (raw.target_child_id as string | null) ?? null;
    e.title = (raw.title as string | null) ?? null;
    e.body = (raw.body as string | null) ?? null;
    e.title_i18n =
      (raw.title_i18n as ContentPostRelationalEntity['title_i18n']) ?? null;
    e.body_i18n =
      (raw.body_i18n as ContentPostRelationalEntity['body_i18n']) ?? null;
    e.media_urls = (raw.media_urls as string[] | null) ?? null;
    e.metadata = (raw.metadata as Record<string, unknown> | null) ?? null;
    e.scheduled_for = raw.scheduled_for
      ? new Date(raw.scheduled_for as string | Date)
      : null;
    e.published_at = raw.published_at
      ? new Date(raw.published_at as string | Date)
      : null;
    e.expires_at = raw.expires_at
      ? new Date(raw.expires_at as string | Date)
      : null;
    e.status = raw.status as ContentStatus;
    e.created_by = (raw.created_by as string | null) ?? null;
    e.created_at = new Date(raw.created_at as string | Date);
    e.updated_at = new Date(raw.updated_at as string | Date);
    return ContentPostMapper.toDomain(e);
  }

  async listScheduledDue(
    kindergartenId: string,
    now: Date,
    limit: number,
  ): Promise<ContentPost[]> {
    const rows = await this.manager()
      .getRepository(ContentPostRelationalEntity)
      .createQueryBuilder('p')
      .where('p.kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere(`p.status = 'scheduled'`)
      .andWhere('p.scheduled_for <= :now', { now })
      .orderBy('p.scheduled_for', 'ASC')
      .addOrderBy('p.id', 'ASC')
      .take(limit > 0 ? limit : 100)
      .getMany();
    return rows.map((r) => ContentPostMapper.toDomain(r));
  }

  async existsBirthdayForChildOnDate(
    kindergartenId: string,
    childId: string,
    date: Date,
  ): Promise<boolean> {
    const m = this.manager();
    // Convert published_at to Asia/Almaty calendar date and compare to the
    // calendar date passed in (also normalised). The migration already
    // creates `idx_content_posts_target_child` (partial WHERE NOT NULL)
    // which is hit via the `target_child_id = $2` predicate.
    const isoDate = toIsoDate(date);
    const rows = (await m.query(
      `SELECT 1 AS one
         FROM content_posts
        WHERE kindergarten_id = $1
          AND content_type = 'birthday'
          AND target_child_id = $2
          AND DATE(published_at AT TIME ZONE 'Asia/Almaty') = $3::date
        LIMIT 1`,
      [kindergartenId, childId, isoDate],
    )) as Array<{ one: number }>;
    return rows.length > 0;
  }

  private manager(): EntityManager {
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.repo.manager;
  }
}

/**
 * Format a Date as `YYYY-MM-DD` in UTC. Callers that want a calendar date
 * in Asia/Almaty should pass a Date that already lives at midnight in
 * that zone (the cron processor's `runDaily` does so via `now.toLocaleDateString` semantics
 * around the dispatch boundary).
 */
function toIsoDate(d: Date): string {
  const yyyy = d.getUTCFullYear().toString().padStart(4, '0');
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = d.getUTCDate().toString().padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
