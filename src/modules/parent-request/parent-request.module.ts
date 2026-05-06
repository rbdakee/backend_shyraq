import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ParentRequestTypeOrmEntity } from './infrastructure/persistence/relational/entities/parent-request.typeorm.entity';
import { ParentRequestMessageTypeOrmEntity } from './infrastructure/persistence/relational/entities/parent-request-message.typeorm.entity';
import { ParentRequestRepository } from './parent-request.repository';
import { ParentRequestRelationalRepository } from './infrastructure/persistence/relational/repositories/parent-request.relational-repository';
import { ParentRequestMessageRepository } from './parent-request-message.repository';
import { ParentRequestMessageRelationalRepository } from './infrastructure/persistence/relational/repositories/parent-request-message.relational-repository';

/**
 * ParentRequestModule (B12). Wires the `parent_requests` + `parent_request_messages`
 * persistence ports and exposes their abstract repository tokens for injection.
 *
 * T3 will extend this module with:
 *   - ParentRequestService (business logic)
 *   - 3 role-scoped controllers (parent / staff / admin)
 *   - Cross-module deps (ChildModule, StaffModule, PickupModule, NotificationModule)
 *
 * `AuthModule` is `@Global()` and exports `SmsPort` + `OtpStorePort`.
 * `NotificationPort` resolves via the global `NotificationModule`.
 * `RedisService` and `ClockPort` resolve from their global modules.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ParentRequestTypeOrmEntity,
      ParentRequestMessageTypeOrmEntity,
    ]),
  ],
  providers: [
    {
      provide: ParentRequestRepository,
      useClass: ParentRequestRelationalRepository,
    },
    {
      provide: ParentRequestMessageRepository,
      useClass: ParentRequestMessageRelationalRepository,
    },
  ],
  exports: [ParentRequestRepository, ParentRequestMessageRepository],
})
export class ParentRequestModule {}
