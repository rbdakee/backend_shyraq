import { AppConfig } from './app-config.type';
import { DatabaseConfig } from '../database/config/database-config.type';
import { RedisConfig } from '../redis/config/redis-config.type';
import { AuthConfig } from '../modules/auth/config/auth-config.type';
import { KaspiCryptoConfig } from '../shared-kernel/config/kaspi-crypto-config.type';
import { CctvConfig } from '../modules/camera/config/cctv-config.type';

export type AllConfigType = {
  app: AppConfig;
  database: DatabaseConfig;
  redis: RedisConfig;
  auth: AuthConfig;
  kaspiCrypto: KaspiCryptoConfig;
  cctv: CctvConfig;
};
