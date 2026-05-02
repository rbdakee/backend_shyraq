import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, MoreThan, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { QrToken } from '../../../../domain/entities/qr-token.entity';
import { IdentityQrRepository } from '../../identity-qr.repository';
import { UserQrTokenTypeOrmEntity } from '../entities/user-qr-token.typeorm.entity';
import { QrTokenMapper } from '../mappers/qr-token.mapper';

@Injectable()
export class IdentityQrRelationalRepository extends IdentityQrRepository {
  constructor(
    @InjectRepository(UserQrTokenTypeOrmEntity)
    private readonly repo: Repository<UserQrTokenTypeOrmEntity>,
  ) {
    super();
  }

  async findActiveByUserAndPurpose(
    userId: string,
    purpose: 'identity',
    now: Date,
  ): Promise<QrToken | null> {
    const m = this.manager();
    const row = await m.getRepository(UserQrTokenTypeOrmEntity).findOne({
      where: {
        user_id: userId,
        purpose,
        revoked_at: IsNull(),
        expires_at: MoreThan(now),
      },
      order: { issued_at: 'DESC' },
    });
    return row ? QrTokenMapper.toDomain(row) : null;
  }

  async findByTokenHash(tokenHash: string): Promise<QrToken | null> {
    const m = this.manager();
    const row = await m
      .getRepository(UserQrTokenTypeOrmEntity)
      .findOne({ where: { token_hash: tokenHash } });
    return row ? QrTokenMapper.toDomain(row) : null;
  }

  async create(token: QrToken): Promise<QrToken> {
    const m = this.manager();
    // Save the persistence-shape entity. The 64-hex `token_hash` collision
    // probability at SHA-256 is 2^-128 — we let the unique violation bubble
    // unmapped if it ever happens (it won't).
    const saved = await m
      .getRepository(UserQrTokenTypeOrmEntity)
      .save(QrTokenMapper.toPersistence(token));
    return QrTokenMapper.toDomain(saved);
  }

  async revokeAllByUser(
    userId: string,
    purpose: 'identity',
    now: Date,
  ): Promise<{ revokedHashes: string[] }> {
    const m = this.manager();
    const result = await m
      .createQueryBuilder()
      .update(UserQrTokenTypeOrmEntity)
      .set({ revoked_at: now })
      .where(
        'user_id = :userId AND purpose = :purpose AND revoked_at IS NULL',
        { userId, purpose },
      )
      .returning(['token_hash'])
      .execute();
    const raw = (result.raw ?? []) as Array<{ token_hash: string }>;
    return { revokedHashes: raw.map((r) => r.token_hash) };
  }

  async revokeById(id: string, now: Date): Promise<void> {
    const m = this.manager();
    await m
      .getRepository(UserQrTokenTypeOrmEntity)
      .update({ id, revoked_at: IsNull() }, { revoked_at: now });
  }

  async updateLastScannedAt(id: string, now: Date): Promise<void> {
    const m = this.manager();
    await m
      .getRepository(UserQrTokenTypeOrmEntity)
      .update({ id }, { last_scanned_at: now });
  }

  /**
   * Selects the EntityManager bound to the active tenant transaction (set
   * by `TenantContextInterceptor`) when present, otherwise falls back to
   * the repository's default pool manager. The fallback is required for
   * cross-tenant endpoints (e.g. `GET /users/me/qr` runs without
   * `KindergartenScopeGuard`, so no `tenantStorage` is set up) and for
   * CLI-scripts / integration tests outside the HTTP pipeline.
   */
  private manager(): EntityManager {
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.repo.manager;
  }
}
