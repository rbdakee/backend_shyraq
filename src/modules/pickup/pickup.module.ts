import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PickupRequestTypeOrmEntity } from './infrastructure/persistence/relational/entities/pickup-request.typeorm.entity';
import { TrustedPersonTypeOrmEntity } from './infrastructure/persistence/relational/entities/trusted-person.typeorm.entity';
import { PickupRequestRelationalRepository } from './infrastructure/persistence/relational/repositories/pickup-request.relational.repository';
import { TrustedPersonRelationalRepository } from './infrastructure/persistence/relational/repositories/trusted-person.relational.repository';
import { PickupRequestRepository } from './infrastructure/persistence/pickup-request.repository';
import { TrustedPersonRepository } from './infrastructure/persistence/trusted-person.repository';

/**
 * PickupModule (B11). Wires the `trusted_people` + `pickup_requests`
 * persistence ports to their TypeORM-backed adapters. Tenant-scoped: both
 * tables have RLS policies; runtime requests pass through the global
 * `TenantContextInterceptor` which sets `app.kindergarten_id` for the
 * surrounding TX.
 *
 * T3 owns persistence only — services + controllers + DTOs land in T4. At
 * that point this module will also need to:
 *   - import AttendanceModule (forwardRef if cyclic) so PickupRequestService
 *     can call AttendanceService.checkOut for the OTP-validate happy path,
 *   - import ChildModule for ChildRepository + ChildGuardianRepository
 *     (parent-permission validation on send-otp),
 *   - export AuthModule already provides OtpStorePort + SmsPort, but
 *     these are not exported from AuthModule today (only SmsPort is) —
 *     T4 will either bring up a pickup-specific PickupOtpStorePort
 *     adapter using `RedisService` directly (recommended, see
 *     `infrastructure/otp/pickup-otp-cache.namespace.ts`), or extend
 *     AuthModule's exports to include OtpStorePort.
 *   - NotificationModule is @Global so NotificationDispatcher resolves
 *     without an explicit import; T4 will add `pickup.otp_sent` +
 *     `pickup.validated` template registrations there.
 *
 * The repos are exported so future modules can read pickup state without
 * going through PickupRequestService.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      TrustedPersonTypeOrmEntity,
      PickupRequestTypeOrmEntity,
    ]),
  ],
  providers: [
    {
      provide: TrustedPersonRepository,
      useClass: TrustedPersonRelationalRepository,
    },
    {
      provide: PickupRequestRepository,
      useClass: PickupRequestRelationalRepository,
    },
  ],
  controllers: [],
  exports: [TrustedPersonRepository, PickupRequestRepository],
})
export class PickupModule {}
