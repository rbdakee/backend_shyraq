import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import {
  KaspiGlobalConfig,
  KaspiGlobalConfigPatch,
} from '../../../../domain/kaspi-global-config';
import { KaspiGlobalConfigRepository } from '../../kaspi-global-config.repository';
import { KaspiGlobalConfigTypeOrmEntity } from '../entities/kaspi-global-config.typeorm.entity';
import { KaspiGlobalConfigMapper } from '../mappers/kaspi-global-config.mapper';

/** Singleton row id enforced by DB CHECK chk_kaspi_global_config_singleton. */
const SINGLETON_ID = 1;

@Injectable()
export class KaspiGlobalConfigRelationalRepository extends KaspiGlobalConfigRepository {
  constructor(
    @InjectRepository(KaspiGlobalConfigTypeOrmEntity)
    private readonly repo: Repository<KaspiGlobalConfigTypeOrmEntity>,
  ) {
    super();
  }

  /**
   * Resolves the EntityManager for the current call. For reads/writes within
   * an HTTP request the tenant transaction manager from AsyncLocalStorage is
   * used; for CLI scripts, cron jobs, and integration tests the fallback to
   * `this.repo.manager` applies automatically.
   *
   * This table has NO RLS, but we follow the same helper pattern as the rest
   * of the codebase for consistency.
   */
  private manager() {
    return tenantStorage.getStore()?.entityManager ?? this.repo.manager;
  }

  async get(): Promise<KaspiGlobalConfig> {
    const row = await this.manager()
      .getRepository(KaspiGlobalConfigTypeOrmEntity)
      .findOne({ where: { id: SINGLETON_ID } });

    if (!row) {
      throw new Error(
        'kaspi_global_config_missing: singleton row (id=1) not found — DB bootstrap failure',
      );
    }

    return KaspiGlobalConfigMapper.toDomain(row);
  }

  async update(
    patch: KaspiGlobalConfigPatch,
    updatedBy: string,
  ): Promise<KaspiGlobalConfig> {
    const m = this.manager();
    const repo = m.getRepository(KaspiGlobalConfigTypeOrmEntity);

    // Map camelCase patch fields → TypeORM column names
    const updatePayload: Partial<KaspiGlobalConfigTypeOrmEntity> = {
      updatedBy,
      updatedAt: new Date(),
    };

    if (patch.appVersion !== undefined)
      updatePayload.appVersion = patch.appVersion;
    if (patch.appBuild !== undefined) updatePayload.appBuild = patch.appBuild;
    if (patch.platformVer !== undefined)
      updatePayload.platformVer = patch.platformVer;
    if (patch.model !== undefined) updatePayload.model = patch.model;
    if (patch.brand !== undefined) updatePayload.brand = patch.brand;
    if (patch.uaNative !== undefined) updatePayload.uaNative = patch.uaNative;
    if (patch.uaBrowser !== undefined)
      updatePayload.uaBrowser = patch.uaBrowser;
    if (patch.entranceUrl !== undefined)
      updatePayload.entranceUrl = patch.entranceUrl;
    if (patch.mtokenUrl !== undefined)
      updatePayload.mtokenUrl = patch.mtokenUrl;
    if (patch.qrpayUrl !== undefined) updatePayload.qrpayUrl = patch.qrpayUrl;

    await repo.update({ id: SINGLETON_ID }, updatePayload);

    const updated = await repo.findOne({ where: { id: SINGLETON_ID } });
    if (!updated) {
      throw new Error(
        'kaspi_global_config_missing: singleton row (id=1) vanished after update',
      );
    }

    return KaspiGlobalConfigMapper.toDomain(updated);
  }
}
