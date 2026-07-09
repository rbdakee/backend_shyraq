import {
  BccMerchantAccount,
  BccMerchantAccountState,
} from '../../../../domain/entities/bcc-merchant-account.entity';
import { BccMerchantAccountTypeOrmEntity } from '../entities/bcc-merchant-account.typeorm.entity';

export class BccMerchantAccountMapper {
  static toDomain(row: BccMerchantAccountTypeOrmEntity): BccMerchantAccount {
    const state: BccMerchantAccountState = {
      id: row.id,
      kindergartenId: row.kindergartenId,
      merchantId: row.merchantId,
      terminalId: row.terminalId,
      merchantName: row.merchantName,
      macKeyEnc: row.macKeyEnc,
      environment: row.environment,
      status: row.status,
      callbackTokenHash: row.callbackTokenHash,
      callbackTokenEnc: row.callbackTokenEnc,
      notifyUsername: row.notifyUsername,
      notifyPasswordHash: row.notifyPasswordHash,
      lastConnectionCheckedAt: row.lastConnectionCheckedAt,
      lastConnectionResult: row.lastConnectionResult,
      disabledAt: row.disabledAt,
      updatedBy: row.updatedBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    return BccMerchantAccount.fromState(state);
  }
}
