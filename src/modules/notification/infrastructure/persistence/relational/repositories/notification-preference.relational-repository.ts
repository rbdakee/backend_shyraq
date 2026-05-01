import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  NotificationPreferenceFlags,
  NotificationPreferenceRepository,
} from '../../../../notification-preference.repository';
import { NotificationPreferenceTypeOrmEntity } from '../entities/notification-preference.typeorm-entity';

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
}
