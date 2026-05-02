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

  /**
   * Upsert a device token — globally unique by `(platform, token)`.
   *
   * Conflict semantics (post B9 review HIGH#3): the unique key is
   * `(platform, token)`, NOT `(user_id, token)`. If the same `(platform,
   * token)` row already exists under a DIFFERENT `user_id` (shared
   * physical device, user-switch on the same handset), this UPSERT
   * transfers ownership: the row's `user_id` is updated to the current
   * caller's `user_id` and the previous owner stops receiving push for
   * that token. This is atomic — no race window where two rows coexist.
   *
   * Implementation is raw `INSERT ... ON CONFLICT (platform, token) DO
   * UPDATE SET ... RETURNING *` because TypeORM's QueryBuilder `orUpdate`
   * cannot return the canonical row in a single round-trip across all
   * dialects, and a separate `findOne` would need `FOR UPDATE` to be
   * race-safe.
   */
  async upsert(input: PushTokenUpsertInput): Promise<PushToken> {
    const now = new Date();
    const rows = await this.repo.query<PushTokenTypeOrmEntity[]>(
      `INSERT INTO push_tokens
         (user_id, token, platform, app_version, device_id, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (platform, token) DO UPDATE
          SET user_id      = EXCLUDED.user_id,
              app_version  = EXCLUDED.app_version,
              device_id    = EXCLUDED.device_id,
              last_seen_at = EXCLUDED.last_seen_at
       RETURNING id, user_id, token, platform, app_version, device_id,
                 last_seen_at, created_at`,
      [
        input.userId,
        input.token,
        input.platform,
        input.appVersion ?? null,
        input.deviceId ?? null,
        now,
      ],
    );
    return this.toModel(rows[0]);
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
      lastSeenAt: new Date(r.last_seen_at),
      createdAt: new Date(r.created_at),
    };
  }
}
