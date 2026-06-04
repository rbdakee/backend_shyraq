import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClockPort } from './application/ports/clock.port';
import { CryptoCipherPort } from './application/ports/crypto-cipher.port';
import { DatabasePingPort } from './application/ports/database-ping.port';
import { TransactionRunnerPort } from './application/ports/transaction-runner.port';
import { AesGcmCryptoCipherAdapter } from './infrastructure/adapters/aes-gcm-crypto-cipher.adapter';
import { SystemClockAdapter } from './infrastructure/adapters/system-clock.adapter';
import { TypeOrmDatabasePingAdapter } from './infrastructure/adapters/typeorm-database-ping.adapter';
import { TypeOrmTransactionRunnerAdapter } from './infrastructure/adapters/typeorm-transaction-runner.adapter';
import { UnconfiguredCryptoCipherAdapter } from './infrastructure/adapters/unconfigured-crypto-cipher.adapter';
import { AllConfigType } from '../config/config.type';

/**
 * Shared kernel — providers that every other module can depend on without
 * importing this module explicitly. Currently:
 *   - ClockPort (system clock)
 *   - TransactionRunnerPort (TypeORM-backed atomic unit of work)
 *   - DatabasePingPort (readiness `SELECT 1`)
 *   - CryptoCipherPort (AES-256-GCM at-rest encryption for Kaspi credentials)
 *
 * `NotificationPort` is now wired by `NotificationModule` (which is also
 * `@Global()`) — it binds the real outbox-backed adapter and re-exports the
 * port. SharedKernelModule no longer provides a default fallback.
 */
@Global()
@Module({
  providers: [
    { provide: ClockPort, useClass: SystemClockAdapter },
    {
      provide: TransactionRunnerPort,
      useClass: TypeOrmTransactionRunnerAdapter,
    },
    { provide: DatabasePingPort, useClass: TypeOrmDatabasePingAdapter },
    {
      provide: CryptoCipherPort,
      inject: [ConfigService],
      useFactory: (configService: ConfigService<AllConfigType>) => {
        const hex = configService.get('kaspiCrypto.encryptionKeyHex', {
          infer: true,
        });

        if (!hex) {
          // Key absent — non-Kaspi envs boot fine; any actual cipher use throws.
          return new UnconfiguredCryptoCipherAdapter();
        }

        // Key present but wrong length — fail fast at startup to surface
        // misconfiguration immediately (the validator in kaspi-crypto.config.ts
        // enforces 64 hex chars, but we guard here as defence-in-depth).
        if (hex.length !== 64) {
          throw new Error('kaspi_encryption_key_invalid_length');
        }

        return new AesGcmCryptoCipherAdapter(Buffer.from(hex, 'hex'));
      },
    },
  ],
  exports: [
    ClockPort,
    TransactionRunnerPort,
    DatabasePingPort,
    CryptoCipherPort,
  ],
})
export class SharedKernelModule {}
