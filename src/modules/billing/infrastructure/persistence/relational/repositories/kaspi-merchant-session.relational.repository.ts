import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { KaspiMerchantSession } from '../../../../domain/entities/kaspi-merchant-session.entity';
import { KaspiMerchantSessionRepository } from '../../kaspi-merchant-session.repository';
import { KaspiMerchantSessionTypeOrmEntity } from '../entities/kaspi-merchant-session.typeorm.entity';
import { KaspiMerchantSessionMapper } from '../mappers/kaspi-merchant-session.mapper';

/**
 * Relational impl of `KaspiMerchantSessionRepository` (B24 / K5).
 *
 * Manager resolution: tenant-scoped methods read the ambient EntityManager from
 * `tenantStorage` so the per-request `SET LOCAL app.kindergarten_id` GUC stays
 * in effect for RLS. `findByKindergartenIdBypassRls` opens its own TX with
 * `SET LOCAL app.bypass_rls='true'` (poller path — no HTTP tenant context),
 * pinned to that TX so the bypass never leaks into the ambient TX.
 */
@Injectable()
export class KaspiMerchantSessionRelationalRepository extends KaspiMerchantSessionRepository {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(KaspiMerchantSessionTypeOrmEntity)
    private readonly repo: Repository<KaspiMerchantSessionTypeOrmEntity>,
  ) {
    super();
  }

  private manager(explicit?: EntityManager): EntityManager {
    if (explicit) return explicit;
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.dataSource.manager;
  }

  async findByKindergartenId(
    kindergartenId: string,
  ): Promise<KaspiMerchantSession | null> {
    const row = await this.manager()
      .getRepository(KaspiMerchantSessionTypeOrmEntity)
      .findOne({ where: { kindergartenId } });
    return row ? KaspiMerchantSessionMapper.toDomain(row) : null;
  }

  async findByKindergartenIdBypassRls(
    kindergartenId: string,
  ): Promise<KaspiMerchantSession | null> {
    return this.dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      const row = await m
        .getRepository(KaspiMerchantSessionTypeOrmEntity)
        .findOne({ where: { kindergartenId } });
      return row ? KaspiMerchantSessionMapper.toDomain(row) : null;
    });
  }

  async save(session: KaspiMerchantSession): Promise<KaspiMerchantSession> {
    return this.upsertWith(this.manager(), session);
  }

  async saveBypassRls(
    session: KaspiMerchantSession,
  ): Promise<KaspiMerchantSession> {
    // K8 poller path — no ambient tenant TX. Open a self-contained TX and pin
    // `app.bypass_rls='true'` to it so the FORCE-RLS upsert is not filtered to
    // 0 rows. Mirrors `findByKindergartenIdBypassRls`; the bypass GUC never
    // leaks past this TX.
    return this.dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      return this.upsertWith(m, session);
    });
  }

  async touchLastCheckedAtBypassRls(
    kindergartenId: string,
    now: Date,
  ): Promise<void> {
    // K8 poller path — no ambient tenant TX. Pin `app.bypass_rls='true'` to a
    // fresh self-contained TX so the FORCE-RLS UPDATE is not filtered to 0
    // rows, and the bypass GUC never leaks past this TX. Targeted UPDATE — the
    // encrypted credential blobs are intentionally NOT rewritten, and
    // `updated_at` is deliberately left untouched so this debounce hook never
    // races/clobbers a concurrent real credential write (saveBypassRls).
    await this.dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      await m.query(
        `UPDATE kaspi_merchant_session
            SET last_checked_at = $2
          WHERE kindergarten_id = $1`,
        [kindergartenId, now],
      );
    });
  }

  /**
   * Shared upsert keyed on the UNIQUE kindergarten_id so re-onboarding
   * overwrites the existing row in place rather than violating the unique
   * constraint. `id` is intentionally NOT updated on conflict (the existing
   * row keeps its PK); created_at is preserved by omitting it from the update
   * set. The caller supplies the EntityManager (ambient-tenant or bypass-RLS).
   */
  private async upsertWith(
    m: EntityManager,
    session: KaspiMerchantSession,
  ): Promise<KaspiMerchantSession> {
    const s = session.toState();
    await m.getRepository(KaspiMerchantSessionTypeOrmEntity).upsert(
      {
        id: s.id,
        kindergartenId: s.kindergartenId,
        connectedByUserId: s.connectedByUserId,
        status: s.status,
        cashierPhone: s.cashierPhone,
        kaspiProfileId: s.kaspiProfileId,
        kaspiOrgId: s.kaspiOrgId,
        orgName: s.orgName,
        tokenSn: s.tokenSn,
        vtokenSecretEnc: s.vtokenSecretEnc,
        deviceKeypairEnc: s.deviceKeypairEnc,
        ecdhKeypairEnc: s.ecdhKeypairEnc,
        deviceId: s.deviceId,
        installId: s.installId,
        pinHash: s.pinHash,
        lastCheckedAt: s.lastCheckedAt,
        updatedAt: s.updatedAt,
      },
      {
        conflictPaths: ['kindergartenId'],
        skipUpdateIfNoValuesChanged: false,
      },
    );

    const row = await m
      .getRepository(KaspiMerchantSessionTypeOrmEntity)
      .findOneOrFail({ where: { kindergartenId: s.kindergartenId } });
    return KaspiMerchantSessionMapper.toDomain(row);
  }
}
