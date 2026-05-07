import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BillingModule } from '@/modules/billing/billing.module';
import { ChildModule } from '@/modules/child/child.module';
import { GroupModule } from '@/modules/group/group.module';
import { PickupModule } from '@/modules/pickup/pickup.module';
import { StaffModule } from '@/modules/staff/staff.module';
import { ParentRequestTypeOrmEntity } from './infrastructure/persistence/relational/entities/parent-request.typeorm.entity';
import { ParentRequestMessageTypeOrmEntity } from './infrastructure/persistence/relational/entities/parent-request-message.typeorm.entity';
import { ParentRequestRelationalRepository } from './infrastructure/persistence/relational/repositories/parent-request.relational-repository';
import { ParentRequestMessageRelationalRepository } from './infrastructure/persistence/relational/repositories/parent-request-message.relational-repository';
import { ParentRequestRepository } from './parent-request.repository';
import { ParentRequestMessageRepository } from './parent-request-message.repository';
import { ParentRequestOtpStorePort } from './infrastructure/otp/parent-request-otp-store.port';
import { RedisParentRequestOtpStoreAdapter } from './infrastructure/otp/redis-parent-request-otp-store.adapter';
import { ParentRequestService } from './parent-request.service';
import { ParentParentRequestController } from './parent-parent-request.controller';
import { StaffParentRequestController } from './staff-parent-request.controller';
import { AdminParentRequestController } from './admin-parent-request.controller';

/**
 * ParentRequestModule (B12). Wires the `parent_requests` + `parent_request_messages`
 * persistence ports + parent-request OTP cache port, registers the service,
 * and exposes three role-scoped HTTP controllers.
 *
 * Cross-module deps:
 *   - `ChildModule`  — `ChildRepository` (existence + group lookup) +
 *                      `ChildGuardianRepository` (permission gate +
 *                      stale-recipient re-validation in dispatcher).
 *   - `GroupModule`  — `GroupRepository.findActiveMentor` for resolving the
 *                      mentor recipient on day_off / vacation / late_pickup.
 *   - `StaffModule`  — `StaffMemberRepository.findById` for open_request
 *                      recipient validation + `findActiveByUserAndKindergarten`
 *                      for staff controller's caller resolution.
 *   - `PickupModule` — `TrustedPersonRepository.create` (accept(trusted_person))
 *                      + `PickupRequestRepository.create` (optional chained
 *                      pickup_request when details.create_pickup_request).
 *
 * `AuthModule` is `@Global()` and exports `SmsPort` + `OtpStorePort` (the
 * latter shared per-phone rate-limit window with auth login).
 * `NotificationPort` resolves via the global `NotificationModule`.
 * `RedisService` and `ClockPort` resolve from their global modules.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ParentRequestTypeOrmEntity,
      ParentRequestMessageTypeOrmEntity,
    ]),
    ChildModule,
    GroupModule,
    StaffModule,
    PickupModule,
    // BillingModule exports `InvoiceService` for the B13 cross-module hook
    // that emits a `late_pickup_fee` invoice on accept(late_pickup) and links
    // it back via `parent_requests.invoice_id`.
    BillingModule,
  ],
  controllers: [
    ParentParentRequestController,
    StaffParentRequestController,
    AdminParentRequestController,
  ],
  providers: [
    ParentRequestService,
    {
      provide: ParentRequestRepository,
      useClass: ParentRequestRelationalRepository,
    },
    {
      provide: ParentRequestMessageRepository,
      useClass: ParentRequestMessageRelationalRepository,
    },
    {
      provide: ParentRequestOtpStorePort,
      useClass: RedisParentRequestOtpStoreAdapter,
    },
  ],
  exports: [ParentRequestRepository, ParentRequestMessageRepository],
})
export class ParentRequestModule {}
