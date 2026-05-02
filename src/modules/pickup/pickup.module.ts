import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AttendanceModule } from '@/modules/attendance/attendance.module';
import { ChildModule } from '@/modules/child/child.module';
import { KindergartenModule } from '@/modules/kindergarten/kindergarten.module';
import { StaffModule } from '@/modules/staff/staff.module';
import { ParentPickupRequestController } from './parent-pickup-request.controller';
import { ParentTrustedPersonController } from './parent-trusted-person.controller';
import { PickupRequestService } from './pickup-request.service';
import { StaffPickupController } from './staff-pickup.controller';
import { TrustedPersonService } from './trusted-person.service';
import { PickupOtpStorePort } from './infrastructure/otp/pickup-otp-store.port';
import { RedisPickupOtpStoreAdapter } from './infrastructure/otp/redis-pickup-otp-store.adapter';
import { PickupRequestTypeOrmEntity } from './infrastructure/persistence/relational/entities/pickup-request.typeorm.entity';
import { TrustedPersonTypeOrmEntity } from './infrastructure/persistence/relational/entities/trusted-person.typeorm.entity';
import { PickupRequestRelationalRepository } from './infrastructure/persistence/relational/repositories/pickup-request.relational.repository';
import { TrustedPersonRelationalRepository } from './infrastructure/persistence/relational/repositories/trusted-person.relational.repository';
import { PickupRequestRepository } from './infrastructure/persistence/pickup-request.repository';
import { TrustedPersonRepository } from './infrastructure/persistence/trusted-person.repository';

/**
 * PickupModule (B11). Wires the `trusted_people` + `pickup_requests`
 * persistence ports + the pickup-OTP cache port, registers two services
 * (staff-pickup orchestration + parent-side trusted-people CRUD), and
 * exposes three role-scoped HTTP controllers.
 *
 * Cross-module deps:
 *   - `AttendanceModule` (forwardRef) — `AttendanceService.checkOut` is the
 *     side-effect of a successful OTP-validate.
 *   - `ChildModule` — `ChildRepository` (existence check) +
 *     `ChildGuardianRepository` (parent-permission validation).
 *   - `KindergartenModule` — `KindergartenRepository.findById` for the SMS
 *     body's kindergarten name.
 *   - `StaffModule` — `StaffMemberRepository.findActiveByUserAndKindergarten`
 *     to resolve the caller's staff_member id (validate-otp `validatedBy`).
 *
 * `AuthModule` is `@Global()` and exports `SmsPort` + `OtpStorePort` (the
 * latter added in T4 — the rate-limit budget is shared with auth login,
 * so reusing the port keeps `rate:otp:{phone}` semantics consistent).
 * `NotificationPort` resolves via the global `NotificationModule`.
 * `RedisService` and `ClockPort` resolve from their global modules.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      TrustedPersonTypeOrmEntity,
      PickupRequestTypeOrmEntity,
    ]),
    forwardRef(() => AttendanceModule),
    ChildModule,
    KindergartenModule,
    StaffModule,
  ],
  providers: [
    PickupRequestService,
    TrustedPersonService,
    {
      provide: TrustedPersonRepository,
      useClass: TrustedPersonRelationalRepository,
    },
    {
      provide: PickupRequestRepository,
      useClass: PickupRequestRelationalRepository,
    },
    {
      provide: PickupOtpStorePort,
      useClass: RedisPickupOtpStoreAdapter,
    },
  ],
  controllers: [
    StaffPickupController,
    ParentTrustedPersonController,
    ParentPickupRequestController,
  ],
  exports: [
    TrustedPersonRepository,
    PickupRequestRepository,
    PickupRequestService,
    TrustedPersonService,
  ],
})
export class PickupModule {}
