import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  PushToken,
  PushTokenRepository,
  PushTokenSummary,
  PushTokenUpsertInput,
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

  async upsert(input: PushTokenUpsertInput): Promise<PushToken> {
    const now = new Date();
    // Use TypeORM upsert with conflict on (user_id, token) unique constraint.
    await this.repo
      .createQueryBuilder()
      .insert()
      .into(PushTokenTypeOrmEntity)
      .values({
        user_id: input.userId,
        token: input.token,
        platform: input.platform,
        app_version: input.appVersion ?? null,
        device_id: input.deviceId ?? null,
        last_seen_at: now,
      })
      .orUpdate(
        ['platform', 'app_version', 'device_id', 'last_seen_at'],
        ['user_id', 'token'],
      )
      .execute();

    // Re-fetch to get the canonical row (including generated id + created_at).
    const row = await this.repo.findOneOrFail({
      where: { user_id: input.userId, token: input.token },
    });
    return this.toModel(row);
  }

  async deleteByIdAndUserId(id: string, userId: string): Promise<boolean> {
    const result = await this.repo.delete({ id, user_id: userId });
    return (result.affected ?? 0) > 0;
  }

  async deleteById(id: string): Promise<void> {
    // Best-effort. If the row was already deleted (concurrent purge or the
    // user re-registered the token under a new id) the DELETE is a no-op
    // and we still return cleanly — the dispatcher does not retry on this.
    await this.repo.delete({ id });
  }

  private toModel(r: PushTokenTypeOrmEntity): PushToken {
    return {
      id: r.id,
      userId: r.user_id,
      platform: r.platform,
      token: r.token,
      appVersion: r.app_version,
      deviceId: r.device_id,
      lastSeenAt: r.last_seen_at,
      createdAt: r.created_at,
    };
  }
}
