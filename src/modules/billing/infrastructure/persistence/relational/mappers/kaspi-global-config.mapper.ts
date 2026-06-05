import { KaspiGlobalConfig } from '../../../../domain/kaspi-global-config';
import { KaspiGlobalConfigTypeOrmEntity } from '../entities/kaspi-global-config.typeorm.entity';

export class KaspiGlobalConfigMapper {
  static toDomain(row: KaspiGlobalConfigTypeOrmEntity): KaspiGlobalConfig {
    return {
      appVersion: row.appVersion,
      appBuild: row.appBuild,
      platformVer: row.platformVer,
      model: row.model,
      brand: row.brand,
      uaNative: row.uaNative,
      uaBrowser: row.uaBrowser,
      entranceUrl: row.entranceUrl,
      mtokenUrl: row.mtokenUrl,
      qrpayUrl: row.qrpayUrl,
      updatedBy: row.updatedBy,
      updatedAt: row.updatedAt,
    };
  }
}
