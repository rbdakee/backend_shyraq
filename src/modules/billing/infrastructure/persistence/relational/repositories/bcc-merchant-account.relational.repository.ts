import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { BccMerchantAccount } from '../../../../domain/entities/bcc-merchant-account.entity';
import { BccMerchantAccountRepository } from '../../bcc-merchant-account.repository';
import { BccMerchantAccountTypeOrmEntity } from '../entities/bcc-merchant-account.typeorm.entity';
import { BccMerchantAccountMapper } from '../mappers/bcc-merchant-account.mapper';

@Injectable()
export class BccMerchantAccountRelationalRepository extends BccMerchantAccountRepository {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(BccMerchantAccountTypeOrmEntity)
    private readonly repo: Repository<BccMerchantAccountTypeOrmEntity>,
  ) {
    super();
  }

  private manager(): EntityManager {
    return tenantStorage.getStore()?.entityManager ?? this.repo.manager;
  }

  async findById(
    kindergartenId: string,
    id: string,
  ): Promise<BccMerchantAccount | null> {
    const row = await this.manager()
      .getRepository(BccMerchantAccountTypeOrmEntity)
      .findOne({ where: { id, kindergartenId } });
    return row ? BccMerchantAccountMapper.toDomain(row) : null;
  }

  async findByKindergartenId(
    kindergartenId: string,
  ): Promise<BccMerchantAccount | null> {
    const row = await this.manager()
      .getRepository(BccMerchantAccountTypeOrmEntity)
      .findOne({ where: { kindergartenId } });
    return row ? BccMerchantAccountMapper.toDomain(row) : null;
  }

  async findByCallbackTokenHashBypassRls(
    callbackTokenHash: string,
  ): Promise<BccMerchantAccount | null> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query(`SELECT set_config('app.bypass_rls', 'true', true)`);
      const row = await manager
        .getRepository(BccMerchantAccountTypeOrmEntity)
        .findOne({ where: { callbackTokenHash } });
      return row ? BccMerchantAccountMapper.toDomain(row) : null;
    });
  }

  async save(account: BccMerchantAccount): Promise<BccMerchantAccount> {
    return this.saveWithManager(account, this.manager());
  }

  async saveBypassRls(
    account: BccMerchantAccount,
  ): Promise<BccMerchantAccount> {
    return this.dataSource.transaction(async (manager) => {
      await manager.query(`SELECT set_config('app.bypass_rls', 'true', true)`);
      return this.saveWithManager(account, manager);
    });
  }

  private async saveWithManager(
    account: BccMerchantAccount,
    manager: EntityManager,
  ): Promise<BccMerchantAccount> {
    const state = account.toState();
    const repository = manager.getRepository(BccMerchantAccountTypeOrmEntity);

    await repository.upsert(
      {
        id: state.id,
        kindergartenId: state.kindergartenId,
        merchantId: state.merchantId,
        terminalId: state.terminalId,
        merchantName: state.merchantName,
        macKeyEnc: state.macKeyEnc,
        environment: state.environment,
        status: state.status,
        callbackTokenHash: state.callbackTokenHash,
        callbackTokenEnc: state.callbackTokenEnc,
        notifyUsername: state.notifyUsername,
        notifyPasswordHash: state.notifyPasswordHash,
        lastConnectionCheckedAt: state.lastConnectionCheckedAt,
        lastConnectionResult: state.lastConnectionResult,
        disabledAt: state.disabledAt,
        updatedBy: state.updatedBy,
        updatedAt: state.updatedAt,
      },
      {
        conflictPaths: ['kindergartenId'],
        skipUpdateIfNoValuesChanged: false,
      },
    );

    const row = await repository.findOneOrFail({
      where: { kindergartenId: state.kindergartenId },
    });
    return BccMerchantAccountMapper.toDomain(row);
  }
}
