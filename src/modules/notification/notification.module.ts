import { Global, Module, Provider } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationPort } from '@/common/notifications/notification.port';
import { ChildModule } from '@/modules/child/child.module';
import { PushNotificationPort } from '@/shared-kernel/domain/push-notification.port';
import { FcmPushAdapter } from '@/shared-kernel/infrastructure/adapters/fcm-push.adapter';
import { MockPushAdapter } from '@/shared-kernel/infrastructure/adapters/mock-push.adapter';
import { NotificationTypeOrmEntity } from './infrastructure/persistence/relational/entities/notification.typeorm-entity';
import { NotificationPreferenceTypeOrmEntity } from './infrastructure/persistence/relational/entities/notification-preference.typeorm-entity';
import { OutboxEventTypeOrmEntity } from './infrastructure/persistence/relational/entities/outbox-event.typeorm-entity';
import { PushTokenTypeOrmEntity } from './infrastructure/persistence/relational/entities/push-token.typeorm-entity';
import { NoopWsBroadcaster } from './infrastructure/noop-ws-broadcaster';
import { OutboxNotificationAdapter } from './infrastructure/outbox-notification.adapter';
import { NotificationPreferenceRelationalRepository } from './infrastructure/persistence/relational/repositories/notification-preference.relational-repository';
import { NotificationRelationalRepository } from './infrastructure/persistence/relational/repositories/notification.relational-repository';
import { OutboxEventRelationalRepository } from './infrastructure/persistence/relational/repositories/outbox-event.relational-repository';
import { PushTokenRelationalRepository } from './infrastructure/persistence/relational/repositories/push-token.relational-repository';
import { NotificationDispatcher } from './notification-dispatcher.service';
import { NotificationPreferenceRepository } from './notification-preference.repository';
import { NotificationRepository } from './notification.repository';
import { OutboxEventRepository } from './outbox-event.repository';
import { PushTokenRepository } from './push-token.repository';
import { WsBroadcaster } from './ws-broadcaster.port';

/**
 * Picks the push adapter based on `process.env.PUSH_PROVIDER`. Defaults to
 * `mock` (logs + records calls). `fcm` resolves to the B22 stub which throws
 * — running the dispatcher with `PUSH_PROVIDER=fcm` is intentionally loud
 * so a misconfigured deployment fails before silently dropping events.
 */
function pushPortProvider(): Provider {
  const provider = (process.env.PUSH_PROVIDER ?? 'mock').toLowerCase();
  return {
    provide: PushNotificationPort,
    useClass: provider === 'fcm' ? FcmPushAdapter : MockPushAdapter,
  };
}

/**
 * NotificationModule — wires the outbox + dispatcher + push + WS stack.
 *
 * Global because it overrides `NotificationPort` (previously bound in
 * SharedKernelModule to `LoggingNotificationAdapter`) — every other module
 * that injects `NotificationPort` must resolve to the new
 * `OutboxNotificationAdapter` without an explicit module-level import.
 *
 * Imports `ChildModule` to inject `ChildGuardianRepository` into the
 * dispatcher's recipient-resolution step.
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([
      OutboxEventTypeOrmEntity,
      NotificationTypeOrmEntity,
      NotificationPreferenceTypeOrmEntity,
      PushTokenTypeOrmEntity,
    ]),
    ChildModule,
  ],
  providers: [
    // Repositories.
    {
      provide: OutboxEventRepository,
      useClass: OutboxEventRelationalRepository,
    },
    {
      provide: NotificationRepository,
      useClass: NotificationRelationalRepository,
    },
    {
      provide: NotificationPreferenceRepository,
      useClass: NotificationPreferenceRelationalRepository,
    },
    { provide: PushTokenRepository, useClass: PushTokenRelationalRepository },
    // Ports / adapters.
    {
      provide: NotificationPort,
      useClass: OutboxNotificationAdapter,
    },
    pushPortProvider(),
    { provide: WsBroadcaster, useClass: NoopWsBroadcaster },
    // Service.
    NotificationDispatcher,
  ],
  exports: [
    OutboxEventRepository,
    NotificationRepository,
    NotificationPreferenceRepository,
    PushTokenRepository,
    NotificationPort,
    PushNotificationPort,
    WsBroadcaster,
    NotificationDispatcher,
  ],
})
export class NotificationModule {}
