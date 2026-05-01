import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import {
  NotificationCreateInput,
  NotificationRepository,
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

  private manager(explicit?: EntityManager): EntityManager {
    if (explicit) return explicit;
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.repo.manager;
  }
}
