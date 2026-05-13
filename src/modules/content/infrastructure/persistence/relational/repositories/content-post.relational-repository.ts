import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { formatDateInTimezone } from '@/shared-kernel/domain/value-objects/day-of-week.vo';
import {
  ContentPost,
  ContentStatus,
} from '../../../../domain/entities/content-post.entity';
import {
  ContentRepository,
  ListContentFilters,
  TransitionStatusPatch,
} from '../../../../content.repository';
import { ContentPostRelationalEntity } from '../entities/content-post.typeorm.entity';
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

    // TypeORM's `EntityManager.query()` wraps the `pg` driver response for DML
    // statements with RETURNING as `[rowsArray, affectedCount]`. The first
    // element is the array of returned row-objects; the second is the integer
    // affected-row count. We extract the rows from index 0.
    const queryResult = (await m.query(sql, params)) as unknown;
    const rows: unknown[] = Array.isArray(queryResult)
      ? Array.isArray(queryResult[0])
        ? (queryResult[0] as unknown[])
        : (queryResult as unknown[])
      : [];
    if (rows.length === 0) return null;
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

  async listNewsForChild(
    kindergartenId: string,
    childId: string,
    groupId: string | null,
    limit: number,
  ): Promise<ContentPost[]> {
    const m = this.manager();
    const cap = limit > 0 ? limit : 10;

    // Build a single query with an OR predicate that covers all three
    // targeting buckets (all / group / child) in one round-trip, replacing
    // the three separate `list()` calls previously issued in parallel.
    //
    // When the child has no current group (groupId = null) we skip the
    // group-targeting branch.
    const params: unknown[] = [kindergartenId, childId, cap];
    let groupBranch = 'false'; // no group → group-targeting branch never matches
    if (groupId !== null) {
      params.push(groupId); // $4
      groupBranch = "(p.target_type = 'group' AND p.target_group_id = $4)";
    }

    const sql = `
      SELECT *
        FROM content_posts p
       WHERE p.kindergarten_id = $1
         AND p.content_type = 'news'
         AND p.status = 'published'
         AND (
               p.target_type = 'all'
            OR ${groupBranch}
            OR (p.target_type = 'child' AND p.target_child_id = $2)
             )
       ORDER BY COALESCE(p.published_at, p.created_at) DESC,
                p.created_at DESC,
                p.id DESC
       LIMIT $3
    `;

    const rows = (await m.query(sql, params)) as Array<Record<string, unknown>>;
    return rows.map((raw) => {
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
      e.status = raw.status as ContentPostRelationalEntity['status'];
      e.created_by = (raw.created_by as string | null) ?? null;
      e.created_at = new Date(raw.created_at as string | Date);
      e.updated_at = new Date(raw.updated_at as string | Date);
      return ContentPostMapper.toDomain(e);
    });
  }

  async acquireBirthdayAdvisoryLock(
    kindergartenId: string,
    childId: string,
    date: Date,
  ): Promise<void> {
    const isoDate = formatDateInTimezone(date);
    const m = this.manager();
    await m.query(
      `SELECT pg_advisory_xact_lock(hashtext('birthday:' || $1 || ':' || $2 || ':' || $3)::bigint)`,
      [kindergartenId, childId, isoDate],
    );
  }

  async existsBirthdayForChildOnDate(
    kindergartenId: string,
    childId: string,
    date: Date,
  ): Promise<boolean> {
    const m = this.manager();
    // Convert published_at to Asia/Almaty calendar date and compare to the
    // calendar date passed in (also normalised). B22a T2 / B17 MEDIUM#11:
    // the predicate `DATE(published_at AT TIME ZONE 'Asia/Almaty')` is
    // STABLE (not IMMUTABLE) so a plain btree index on `published_at`
    // cannot be used. Migration `B22ContentBirthdayDateIndex` adds a
    // partial functional index `idx_content_posts_birthday_date_almaty`
    // ON `(kindergarten_id, target_child_id, DATE(published_at AT TIME
    // ZONE 'Asia/Almaty'))` WHERE `content_type='birthday'` so this
    // lookup is index-only.
    const isoDate = formatDateInTimezone(date);
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
