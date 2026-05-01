import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  PushTokenRepository,
  PushTokenSummary,
} from '../../../../push-token.repository';
import { PushTokenTypeOrmEntity } from '../entities/push-token.typeorm.entity';

@Injectable()
export class PushTokenRelationalRepository extends PushTokenRepository {
  constructor(
    @InjectRepository(PushTokenTypeOrmEntity)
    private readonly repo: Repository<PushTokenTypeOrmEntity>,
  ) {
    super();
  }

  async findByUserIds(userIds: string[]): Promise<PushTokenSummary[]> {
    if (userIds.length === 0) return [];
    const rows = await this.repo.find({ where: { user_id: In(userIds) } });
    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      platform: r.platform,
      token: r.token,
    }));
  }
}
