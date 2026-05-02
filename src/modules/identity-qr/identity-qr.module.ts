import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { QrTokenCachePort } from './infrastructure/cache/qr-token-cache.port';
import { RedisQrTokenCacheAdapter } from './infrastructure/cache/redis-qr-token-cache.adapter';
import { UserQrTokenTypeOrmEntity } from './infrastructure/persistence/relational/entities/user-qr-token.typeorm.entity';
import { IdentityQrRelationalRepository } from './infrastructure/persistence/relational/repositories/identity-qr.relational.repository';
import { IdentityQrRepository } from './infrastructure/persistence/identity-qr.repository';
import { QrScanRateLimiterPort } from './infrastructure/rate-limit/qr-scan-rate-limiter.port';
import { RedisQrScanRateLimiterAdapter } from './infrastructure/rate-limit/redis-qr-scan-rate-limiter.adapter';

/**
 * IdentityQrModule — wires the persistence port, Redis cache port, and
 * Redis rate-limiter port for the B10 Identity QR feature. Service +
 * controllers land in T4.
 *
 * Cross-tenant by design: `user_qr_tokens` is not RLS-scoped, so this
 * module deliberately does not import any tenant-derived providers.
 *
 * `RedisService` is provided globally by `RedisModule` (`@Global()`), so
 * the Redis adapters resolve it without an explicit `imports` entry.
 */
@Module({
  imports: [TypeOrmModule.forFeature([UserQrTokenTypeOrmEntity])],
  providers: [
    {
      provide: IdentityQrRepository,
      useClass: IdentityQrRelationalRepository,
    },
    { provide: QrTokenCachePort, useClass: RedisQrTokenCacheAdapter },
    {
      provide: QrScanRateLimiterPort,
      useClass: RedisQrScanRateLimiterAdapter,
    },
  ],
  exports: [IdentityQrRepository, QrTokenCachePort, QrScanRateLimiterPort],
  controllers: [],
})
export class IdentityQrModule {}
