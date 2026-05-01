import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import {
  NotificationPreference,
  NotificationPreferenceFlags,
  NotificationPreferenceRepository,
  UpsertPreferenceItem,
} from '../../../../notification-preference.repository';
import { NotificationPreferenceTypeOrmEntity } from '../entities/notification-preference.typeorm.entity';

@Injectable()
export class NotificationPreferenceRelationalRepository extends NotificationPreferenceRepository {
  constructor(
    @InjectRepository(NotificationPreferenceTypeOrmEntity)
    private readonly repo: Repository<NotificationPreferenceTypeOrmEntity>,
  ) {
    super();
  }

  async findByUserIdsAndEventKey(
    userIds: string[],
    eventKey: string,
  ): Promise<Map<string, NotificationPreferenceFlags>> {
    if (userIds.length === 0) return new Map();
    const rows = await this.manager()
      .getRepository(NotificationPreferenceTypeOrmEntity)
      .find({ where: { user_id: In(userIds), event_key: eventKey } });
    const map = new Map<string, NotificationPreferenceFlags>();
    for (const row of rows) {
      map.set(row.user_id, {
        push_enabled: row.push_enabled,
        in_app_enabled: row.in_app_enabled,
      });
    }
    return map;
  }

  async listForUser(userId: string): Promise<NotificationPreference[]> {
    const rows = await this.manager()
      .getRepository(NotificationPreferenceTypeOrmEntity)
      .find({ where: { user_id: userId } });
    return rows.map(this.toModel);
  }

  /**
   * Atomic per-row upsert that respects the partial-update contract:
   *
   *   - On INSERT: only the columns the caller actually specified are
   *     written. Unspecified flag columns are omitted from the INSERT
   *     list, so the table-level DEFAULT (true) populates them. This is
   *     the correct opt-in default for a brand-new (user, event_key)
   *     row.
   *   - On CONFLICT: only the columns the caller specified are merged
   *     via `EXCLUDED.col`. Omitted flags are NOT touched on the
   *     existing row — `ON CONFLICT DO UPDATE SET col = EXCLUDED.col`
   *     is built dynamically so SQL itself enforces the merge. This
   *     replaces the pre-fix read+write pattern, which had a race
   *     window where two concurrent PATCH calls could clobber each
   *     other's changes.
   *
   * The whole sequence runs as a single SQL statement per item, so even
   * concurrent PATCH requests from the same user serialize at the
   * row-lock level inside PostgreSQL — no application-side mutex needed.
   */
  async upsertMany(
    userId: string,
    items: UpsertPreferenceItem[],
  ): Promise<NotificationPreference[]> {
    if (items.length === 0) {
      return this.listForUser(userId);
    }

    const mgr = this.manager();
    const now = new Date();
    for (const item of items) {
      const cols: string[] = ['user_id', 'event_key'];
      const vals: unknown[] = [userId, item.eventKey];
      const setParts: string[] = ['updated_at = EXCLUDED.updated_at'];

      if (item.pushEnabled !== undefined) {
        cols.push('push_enabled');
        vals.push(item.pushEnabled);
        setParts.push('push_enabled = EXCLUDED.push_enabled');
      }
      if (item.inAppEnabled !== undefined) {
        cols.push('in_app_enabled');
        vals.push(item.inAppEnabled);
        setParts.push('in_app_enabled = EXCLUDED.in_app_enabled');
      }

      cols.push('updated_at');
      vals.push(now);

      const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
      await mgr.query(
        `INSERT INTO notification_preferences (${cols.join(', ')})
         VALUES (${placeholders})
         ON CONFLICT (user_id, event_key) DO UPDATE
            SET ${setParts.join(', ')}`,
        vals,
      );
    }

    return this.listForUser(userId);
  }

  private manager(): EntityManager {
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.repo.manager;
  }

  private toModel(
    r: NotificationPreferenceTypeOrmEntity,
  ): NotificationPreference {
    return {
      id: r.id,
      userId: r.user_id,
      eventKey: r.event_key,
      pushEnabled: r.push_enabled,
      inAppEnabled: r.in_app_enabled,
      updatedAt: r.updated_at,
    };
  }
}
