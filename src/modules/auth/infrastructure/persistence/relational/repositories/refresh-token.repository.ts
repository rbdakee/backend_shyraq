import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import {
  CreateRefreshInput,
  RefreshTokenRepository,
  RotateOpts,
  RotateResult,
} from '../../refresh-token.repository';
import { RefreshTokenEntity } from '../entities/refresh-token.entity';

@Injectable()
export class RefreshTokenRelationalRepository extends RefreshTokenRepository {
  constructor(
    @InjectRepository(RefreshTokenEntity)
    private readonly repo: Repository<RefreshTokenEntity>,
  ) {
    super();
  }

  async create(input: CreateRefreshInput): Promise<void> {
    const ctx = tenantStorage.getStore();
    if (ctx?.entityManager) {
      await ctx.entityManager.insert(RefreshTokenEntity, {
        user_id: input.userId,
        kindergarten_id: input.kindergartenId,
        token_hash: input.tokenHash,
        device_id: input.deviceId,
        ip_address: input.ipAddress,
        expires_at: input.expiresAt,
      });
    } else {
      await this.repo.manager.transaction(async (tx) => {
        await tx.query(`SET LOCAL app.bypass_rls = 'true'`);
        await tx.insert(RefreshTokenEntity, {
          user_id: input.userId,
          kindergarten_id: input.kindergartenId,
          token_hash: input.tokenHash,
          device_id: input.deviceId,
          ip_address: input.ipAddress,
          expires_at: input.expiresAt,
        });
      });
    }
  }

  async rotate(opts: RotateOpts): Promise<RotateResult | null> {
    const outerManager = this.manager();
    return outerManager.transaction(async (tx) => {
      await tx.query(`SET LOCAL app.bypass_rls = 'true'`);
      const existing = await tx
        .createQueryBuilder(RefreshTokenEntity, 'rt')
        .setLock('pessimistic_write')
        .where('rt.token_hash = :hash', { hash: opts.tokenHash })
        .getOne();
      if (
        !existing ||
        existing.revoked_at !== null ||
        existing.expires_at <= opts.now
      ) {
        return null;
      }
      await tx.update(
        RefreshTokenEntity,
        { id: existing.id },
        { revoked_at: opts.now },
      );
      await tx.insert(RefreshTokenEntity, {
        user_id: existing.user_id,
        kindergarten_id: existing.kindergarten_id,
        token_hash: opts.newTokenHash,
        device_id: opts.deviceIdOverride ?? existing.device_id,
        ip_address: opts.ipAddressOverride ?? existing.ip_address,
        expires_at: opts.newExpiresAt,
      });
      return {
        userId: existing.user_id,
        kindergartenId: existing.kindergarten_id,
      };
    });
  }

  async revokeByHash(tokenHash: string, now: Date): Promise<void> {
    const manager = this.manager();
    await manager
      .createQueryBuilder()
      .update(RefreshTokenEntity)
      .set({ revoked_at: now })
      .where('token_hash = :hash AND revoked_at IS NULL', { hash: tokenHash })
      .execute();
  }

  async revokeAllByUserId(userId: string, now: Date): Promise<void> {
    const manager = this.manager();
    await manager
      .createQueryBuilder()
      .update(RefreshTokenEntity)
      .set({ revoked_at: now })
      .where('user_id = :uid AND revoked_at IS NULL', { uid: userId })
      .execute();
  }

  /**
   * EXISTS-style check for an active refresh-token row owned by `userId` and
   * stamped with `deviceId`. Used by IdentityQrService.scan to confirm that
   * the staff caller really owns the device-id they're submitting in the
   * X-Device-Id header (otherwise a malicious caller could rotate header
   * values to dodge the 60/min rate-limit).
   *
   * Runs under `app.bypass_rls=true` because refresh_tokens is RLS-scoped on
   * `kindergarten_id` but the active tenant for /staff/qr/scan is the
   * SCANNING staff's kg — which is fine for refresh-token reads on that
   * same staff user. We bypass anyway so this method is callable from
   * cross-tenant pipelines (consistency with `findApproved...CrossTenant`).
   */
  async hasActiveSessionForDevice(
    userId: string,
    deviceId: string,
    now: Date,
  ): Promise<boolean> {
    const outerManager = this.manager();
    return outerManager.transaction(async (tx) => {
      await tx.query(`SET LOCAL app.bypass_rls = 'true'`);
      const count = await tx
        .createQueryBuilder(RefreshTokenEntity, 'rt')
        .where('rt.user_id = :uid', { uid: userId })
        .andWhere('rt.device_id = :did', { did: deviceId })
        .andWhere('rt.revoked_at IS NULL')
        .andWhere('rt.expires_at > :now', { now })
        .getCount();
      return count > 0;
    });
  }

  /**
   * Selects the EntityManager bound to the active tenant transaction (set by
   * TenantContextInterceptor) when present, otherwise falls back to the
   * repository's default manager. Falling back is safe for paths that don't
   * read tenant-scoped tables (e.g. RLS-bypass system jobs, unit tests).
   */
  private manager(): EntityManager {
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.repo.manager;
  }
}
