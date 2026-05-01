import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
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
    const rows = await this.repo.find({
      where: { user_id: In(userIds), event_key: eventKey },
    });
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
    const rows = await this.repo.find({ where: { user_id: userId } });
    return rows.map(this.toModel);
  }

  async upsertMany(
    userId: string,
    items: UpsertPreferenceItem[],
  ): Promise<NotificationPreference[]> {
    if (items.length === 0) {
      return this.listForUser(userId);
    }

    const now = new Date();
    for (const item of items) {
      // Fetch existing row (if any) to merge partial updates.
      const existing = await this.repo.findOne({
        where: { user_id: userId, event_key: item.eventKey },
      });

      const pushEnabled =
        item.pushEnabled !== undefined
          ? item.pushEnabled
          : (existing?.push_enabled ?? true);
      const inAppEnabled =
        item.inAppEnabled !== undefined
          ? item.inAppEnabled
          : (existing?.in_app_enabled ?? true);

      await this.repo
        .createQueryBuilder()
        .insert()
        .into(NotificationPreferenceTypeOrmEntity)
        .values({
          user_id: userId,
          event_key: item.eventKey,
          push_enabled: pushEnabled,
          in_app_enabled: inAppEnabled,
          updated_at: now,
        })
        .orUpdate(
          ['push_enabled', 'in_app_enabled', 'updated_at'],
          ['user_id', 'event_key'],
        )
        .execute();
    }

    return this.listForUser(userId);
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
