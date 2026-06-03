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

  /**
   * Inserts a new refresh token row. Refresh tokens are GLOBAL by design —
   * the same token is valid regardless of which kindergarten context the user
   * later selects, because the tenant switch happens AFTER token issuance
   * (at role-select / OTP-verify time, not at issue time). This means the
   * insert may run before `KindergartenScopeGuard` has set
   * `app.kindergarten_id`, so no ambient tenant GUC is available.
   *
   * When called inside an existing ambient transaction (typical HTTP request
   * path that runs before the scope guard, e.g. OTP-verify) we fall through
   * to the ambient manager which already has the connection. Otherwise we
   * open a fresh transaction off `repo.manager` and `SET LOCAL
   * app.bypass_rls = 'true'` (TX-scoped) so the INSERT sees the table even
   * though `app.kindergarten_id` is not set — `refresh_tokens` has
   * `FORCE ROW LEVEL SECURITY` and the app role is `NOBYPASSRLS`.
   *
   * RLS bypass is intentional here: refresh tokens are cross-tenant by design.
   */
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
        audience: input.audience,
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
          audience: input.audience,
        });
      });
    }
  }

  /**
   * Atomically rotates a refresh token: revokes the old hash and inserts a
   * new one for the same user + kindergarten.
   *
   * RLS bypass is intentional: refresh tokens are global (cross-tenant) by
   * design. A user who holds a token issued for kg-A must still be able to
   * rotate it when connecting with a kg-B context. Without the bypass, the
   * SELECT + UPDATE under `app.kindergarten_id = kg-B` would fail to find
   * the kg-A row and return `null` (session expired), forcing the user to
   * re-authenticate unnecessarily. See `create` JSDoc for the full rationale.
   */
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
        // Carry the audience forward unchanged so a refresh never jumps apps.
        audience: existing.audience,
      });
      return {
        userId: existing.user_id,
        kindergartenId: existing.kindergarten_id,
        audience: existing.audience,
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

  /**
   * Revokes ALL active refresh tokens for `userId` across every kindergarten
   * the user has rows in.
   *
   * Why this is special-cased vs other repo methods:
   *   `refresh_tokens` has FORCE ROW LEVEL SECURITY (see migration
   *   1777593601000-AuthAndUsersTables, policy `tenant_isolation`). Despite
   *   architecture.md §3.5 historically describing the table as "global", it
   *   is FORCE-RLS-protected. If we ran this UPDATE under the ambient
   *   TenantContextInterceptor TX (which sets `app.kindergarten_id` to the
   *   caller's tenant), only rows in the caller's kg would be touched —
   *   leaving tokens in OTHER kindergartens for the same user_id active.
   *   That's a real session-leak: a multi-kg user (e.g. staff in kg-A AND
   *   kg-B, parent with approved guardian rows in two kgs) calling
   *   `/auth/logout` would only kill the kg-A session.
   *
   * We therefore open a transaction off the raw datasource (`this.repo.manager`)
   * — NOT off the ambient `tenantStorage` manager. Inside that transaction we
   * `SET LOCAL app.bypass_rls = 'true'` (TX-scoped) and run the UPDATE so it
   * sees every kg's rows for the user.
   *
   * Trade-off: the UPDATE commits independently of any outer ambient HTTP TX.
   * If the controller throws AFTER `revokeAllByUserId` succeeds (e.g.
   * blocklist-write failure), the revocation persists even though the outer
   * error rolls back the rest. For logout that's the desired bias — the
   * caller asked for "logout from all sessions"; partial-revoked is safer
   * than partial-keep.
   *
   * Why a fresh-connection TX over `outerManager.transaction(...)`: the
   * latter creates a SAVEPOINT inside the ambient TX. PostgreSQL's
   * `RELEASE SAVEPOINT` does NOT reset GUC settings — so `SET LOCAL
   * app.bypass_rls = 'true'` would leak past the savepoint into the rest of
   * the request TX, defeating the tenant guard for everything that runs
   * later in the same handler. The fresh connection isolates the bypass to
   * exactly this UPDATE.
   */
  async revokeAllByUserId(userId: string, now: Date): Promise<void> {
    await this.repo.manager.transaction(async (tx) => {
      await tx.query(`SET LOCAL app.bypass_rls = 'true'`);
      await tx
        .createQueryBuilder()
        .update(RefreshTokenEntity)
        .set({ revoked_at: now })
        .where('user_id = :uid AND revoked_at IS NULL', { uid: userId })
        .execute();
    });
  }

  /**
   * EXISTS-style check for an active refresh-token row owned by `userId` and
   * stamped with `deviceId`. Used by IdentityQrService.scan to confirm that
   * the staff caller really owns the device-id they're submitting in the
   * X-Device-Id header (otherwise a malicious caller could rotate header
   * values to dodge the 60/min rate-limit).
   *
   * No `bypass_rls` here: the caller is checking their OWN session, the
   * refresh_tokens row's `kindergarten_id` was assigned at OTP-verify /
   * role-select to match the JWT's `kindergarten_id` claim
   * (auth.service.ts:530-548 / 313-329), and the ambient tenant context
   * sets `app.kindergarten_id` to that same value — so the row passes RLS
   * naturally. Previously this method opened a sub-transaction
   * (SAVEPOINT inside the ambient HTTP TX) and SET LOCAL
   * `app.bypass_rls = 'true'`. Because RELEASE SAVEPOINT does NOT reset
   * GUC, the bypass leaked into the rest of the request TX — a footgun
   * for any future caller. Plain query through `manager()` closes the
   * leak.
   */
  async hasActiveSessionForDevice(
    userId: string,
    deviceId: string,
    now: Date,
  ): Promise<boolean> {
    const m = this.manager();
    const count = await m
      .createQueryBuilder(RefreshTokenEntity, 'rt')
      .where('rt.user_id = :uid', { uid: userId })
      .andWhere('rt.device_id = :did', { did: deviceId })
      .andWhere('rt.revoked_at IS NULL')
      .andWhere('rt.expires_at > :now', { now })
      .getCount();
    return count > 0;
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
