import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChildModule } from '@/modules/child/child.module';
import { StaffModule } from '@/modules/staff/staff.module';
import { UsersModule } from '@/modules/users/users.module';
import { AdminQrController } from './admin-qr.controller';
import { IdentityQrService } from './identity-qr.service';
import { QrTokenCachePort } from './infrastructure/cache/qr-token-cache.port';
import { RedisQrTokenCacheAdapter } from './infrastructure/cache/redis-qr-token-cache.adapter';
import { UserQrTokenTypeOrmEntity } from './infrastructure/persistence/relational/entities/user-qr-token.typeorm.entity';
import { IdentityQrRelationalRepository } from './infrastructure/persistence/relational/repositories/identity-qr.relational.repository';
import { IdentityQrRepository } from './infrastructure/persistence/identity-qr.repository';
import { QrScanRateLimiterPort } from './infrastructure/rate-limit/qr-scan-rate-limiter.port';
import { RedisQrScanRateLimiterAdapter } from './infrastructure/rate-limit/redis-qr-scan-rate-limiter.adapter';
import { StaffQrController } from './staff-qr.controller';
import { UserQrController } from './user-qr.controller';

/**
 * IdentityQrModule — wires the persistence port, Redis cache port, Redis
 * rate-limiter port, the IdentityQrService, and three role-scoped HTTP
 * controllers for the B10 Identity QR feature.
 *
 * Cross-tenant by design: `user_qr_tokens` is not RLS-scoped. Cross-module
 * dependencies:
 *   - `RefreshTokenRepository` (from the global `AuthModule`) — for
 *     validating that the X-Device-Id header on /staff/qr/scan corresponds
 *     to an active refresh-token row of the calling staff.
 *   - `ChildGuardianRepository` + `ChildRepository` (from `ChildModule`) —
 *     for cross-tenant `linked_children` derivation when scanning a
 *     parent.
 *   - `StaffMemberRepository` (from `StaffModule`) — for effective-role
 *     resolution on a scanned user.
 *   - `UserRepository` (from `UsersModule`) — for hydrating the scanned
 *     user's display fields.
 *
 * `RedisService` (global), `ClockPort` (global via `SharedKernelModule`),
 * and `RefreshTokenRepository` (global via `AuthModule`) all resolve
 * without an explicit `imports` entry.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([UserQrTokenTypeOrmEntity]),
    ChildModule,
    StaffModule,
    UsersModule,
  ],
  providers: [
    IdentityQrService,
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
  controllers: [UserQrController, StaffQrController, AdminQrController],
  exports: [IdentityQrRepository, QrTokenCachePort, QrScanRateLimiterPort],
})
export class IdentityQrModule {}
