import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import {
  CreateSaasRefreshInput,
  RotateSaasOpts,
  RotateSaasResult,
  SaasRefreshTokenRepository,
} from '../../../../saas-refresh-token.repository';
import { SaasRefreshTokenEntity } from '../entities/saas-refresh-token.entity';

@Injectable()
export class SaasRefreshTokenRelationalRepository extends SaasRefreshTokenRepository {
  constructor(
    @InjectRepository(SaasRefreshTokenEntity)
    private readonly repo: Repository<SaasRefreshTokenEntity>,
  ) {
    super();
  }

  async create(input: CreateSaasRefreshInput): Promise<void> {
    const manager = this.manager();
    await manager.insert(SaasRefreshTokenEntity, {
      saas_user_id: input.saasUserId,
      token_hash: input.tokenHash,
      device_id: input.deviceId,
      ip_address: input.ipAddress,
      expires_at: input.expiresAt,
    });
  }

  async rotate(opts: RotateSaasOpts): Promise<RotateSaasResult | null> {
    const outerManager = this.manager();
    return outerManager.transaction(async (tx) => {
      const existing = await tx
        .createQueryBuilder(SaasRefreshTokenEntity, 'srt')
        .setLock('pessimistic_write')
        .where('srt.token_hash = :hash', { hash: opts.tokenHash })
        .getOne();
      if (
        !existing ||
        existing.revoked_at !== null ||
        existing.expires_at <= opts.now
      ) {
        return null;
      }
      await tx.update(
        SaasRefreshTokenEntity,
        { id: existing.id },
        { revoked_at: opts.now },
      );
      await tx.insert(SaasRefreshTokenEntity, {
        saas_user_id: existing.saas_user_id,
        token_hash: opts.newTokenHash,
        device_id: opts.deviceIdOverride ?? existing.device_id,
        ip_address: opts.ipAddressOverride ?? existing.ip_address,
        expires_at: opts.newExpiresAt,
      });
      return { saasUserId: existing.saas_user_id };
    });
  }

  async revokeByHash(tokenHash: string, now: Date): Promise<void> {
    const manager = this.manager();
    await manager
      .createQueryBuilder()
      .update(SaasRefreshTokenEntity)
      .set({ revoked_at: now })
      .where('token_hash = :hash AND revoked_at IS NULL', { hash: tokenHash })
      .execute();
  }

  async revokeAllBySaasUserId(saasUserId: string, now: Date): Promise<void> {
    const manager = this.manager();
    await manager
      .createQueryBuilder()
      .update(SaasRefreshTokenEntity)
      .set({ revoked_at: now })
      .where('saas_user_id = :uid AND revoked_at IS NULL', { uid: saasUserId })
      .execute();
  }

  private manager(): EntityManager {
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.repo.manager;
  }
}
