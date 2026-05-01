import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import {
  ListNotificationsInput,
  NotificationCreateInput,
  NotificationRepository,
  NotificationRow,
} from '../../../../notification.repository';
import { NotificationTypeOrmEntity } from '../entities/notification.typeorm.entity';

@Injectable()
export class NotificationRelationalRepository extends NotificationRepository {
  constructor(
    @InjectRepository(NotificationTypeOrmEntity)
    private readonly repo: Repository<NotificationTypeOrmEntity>,
  ) {
    super();
  }

  async createMany(
    rows: NotificationCreateInput[],
    manager?: EntityManager,
  ): Promise<void> {
    if (rows.length === 0) return;
    const m = this.manager(manager);
    const records = rows.map((r) => {
      const record: Record<string, unknown> = {
        kindergarten_id: r.kindergartenId,
        user_id: r.userId,
        event_key: r.eventKey,
        title_i18n: r.titleI18n,
        body_i18n: r.bodyI18n,
        data: r.data,
        created_at: r.createdAt,
      };
      if (r.id) record.id = r.id;
      return record;
    });
    await m.getRepository(NotificationTypeOrmEntity).insert(records);
  }

  async listForUser(input: ListNotificationsInput): Promise<NotificationRow[]> {
    const m = this.manager();
    const repo = m.getRepository(NotificationTypeOrmEntity);
    const qb = repo
      .createQueryBuilder('n')
      .where('n.kindergarten_id = :kgId', { kgId: input.kindergartenId })
      .andWhere('n.user_id = :userId', { userId: input.userId })
      .orderBy('n.created_at', 'DESC')
      .addOrderBy('n.id', 'DESC')
      .take(input.limit);

    if (input.unreadOnly) {
      qb.andWhere('n.read_at IS NULL');
    }

    if (input.cursor) {
      // Stable cursor: rows with created_at < cursor.createdAt,
      // OR same created_at with id < cursor.id (lexicographic UUIDs are not
      // ordered by time, so we rely on (created_at, id) composite).
      qb.andWhere(
        '(n.created_at < :cursorAt OR (n.created_at = :cursorAt AND n.id < :cursorId))',
        {
          cursorAt: input.cursor.createdAt,
          cursorId: input.cursor.id,
        },
      );
    }

    const rows = await qb.getMany();
    return rows.map(this.toModel);
  }

  async markRead(input: {
    kindergartenId: string;
    id: string;
    userId: string;
  }): Promise<NotificationRow | null> {
    const m = this.manager();
    const repo = m.getRepository(NotificationTypeOrmEntity);
    // Use a filtered UPDATE so we atomically verify ownership.
    const result = await repo
      .createQueryBuilder()
      .update(NotificationTypeOrmEntity)
      .set({ read_at: () => 'NOW()' })
      .where('id = :id', { id: input.id })
      .andWhere('user_id = :userId', { userId: input.userId })
      .andWhere('kindergarten_id = :kgId', { kgId: input.kindergartenId })
      .andWhere('read_at IS NULL')
      .returning('*')
      .execute();

    if (!result.affected || result.affected === 0) {
      // Either not found, wrong owner, or already read — re-fetch to
      // distinguish 404 from "already read".
      const row = await repo.findOne({
        where: { id: input.id, user_id: input.userId },
      });
      if (!row) return null;
      return this.toModel(row);
    }

    // `returning('*')` gives us the updated row.
    const raw = result.raw[0] as NotificationTypeOrmEntity | undefined;
    if (!raw) return null;
    return this.toModel(raw);
  }

  async markAllRead(input: {
    kindergartenId: string;
    userId: string;
  }): Promise<number> {
    const m = this.manager();
    const repo = m.getRepository(NotificationTypeOrmEntity);
    const result = await repo
      .createQueryBuilder()
      .update(NotificationTypeOrmEntity)
      .set({ read_at: () => 'NOW()' })
      .where('user_id = :userId', { userId: input.userId })
      .andWhere('kindergarten_id = :kgId', { kgId: input.kindergartenId })
      .andWhere('read_at IS NULL')
      .execute();
    return result.affected ?? 0;
  }

  private manager(explicit?: EntityManager): EntityManager {
    if (explicit) return explicit;
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.repo.manager;
  }

  private toModel(r: NotificationTypeOrmEntity): NotificationRow {
    return {
      id: r.id,
      kindergartenId: r.kindergarten_id,
      userId: r.user_id,
      eventKey: r.event_key,
      titleI18n: r.title_i18n,
      bodyI18n: r.body_i18n,
      data: r.data,
      readAt: r.read_at,
      createdAt: r.created_at,
    };
  }
}
