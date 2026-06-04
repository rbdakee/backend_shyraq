import { Global, Module, Provider } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationPort } from '@/common/notifications/notification.port';
import { ChildModule } from '@/modules/child/child.module';
import { GroupModule } from '@/modules/group/group.module';
import { UsersModule } from '@/modules/users/users.module';
import { PushNotificationPort } from '@/shared-kernel/domain/push-notification.port';
import { FcmPushAdapter } from '@/shared-kernel/infrastructure/adapters/fcm-push.adapter';
import { buildFirebaseConfig } from '@/shared-kernel/infrastructure/adapters/firebase-push.config';
import { MockPushAdapter } from '@/shared-kernel/infrastructure/adapters/mock-push.adapter';
import { NotificationTypeOrmEntity } from './infrastructure/persistence/relational/entities/notification.typeorm.entity';
import { NotificationPreferenceTypeOrmEntity } from './infrastructure/persistence/relational/entities/notification-preference.typeorm.entity';
import { OutboxEventTypeOrmEntity } from './infrastructure/persistence/relational/entities/outbox-event.typeorm.entity';
import { PushTokenTypeOrmEntity } from './infrastructure/persistence/relational/entities/push-token.typeorm.entity';
import { OutboxNotificationAdapter } from './infrastructure/outbox-notification.adapter';
import { NotificationPreferenceRelationalRepository } from './infrastructure/persistence/relational/repositories/notification-preference.relational-repository';
import { NotificationRelationalRepository } from './infrastructure/persistence/relational/repositories/notification.relational-repository';
import { OutboxEventRelationalRepository } from './infrastructure/persistence/relational/repositories/outbox-event.relational-repository';
import { PushTokenRelationalRepository } from './infrastructure/persistence/relational/repositories/push-token.relational-repository';
import { NotificationDispatcher } from './notification-dispatcher.service';
import { NotificationPreferenceRepository } from './notification-preference.repository';
import { NotificationRepository } from './notification.repository';
import { OutboxEventRepository } from './outbox-event.repository';
import {
  OutboxPruneProcessor,
  OutboxPruneScheduler,
  OUTBOX_PRUNE_QUEUE,
} from './outbox-prune.processor';
import { PushTokenRepository } from './push-token.repository';
import { NotificationService } from './notification.service';
import { PushTokenController } from './push-token.controller';
import { NotificationController } from './notification.controller';
import { NotificationPreferencesController } from './notification-preferences.controller';

/**
 * Picks the push adapter based on `process.env.PUSH_PROVIDER`. Defaults to
 * `mock` (logs + records calls). `fcm` builds the real `firebase-admin`-backed
 * `FcmPushAdapter`, validating the `FIREBASE_*` service-account creds at
 * bootstrap so a misconfigured deployment fails loudly instead of silently
 * dropping events.
 */
function pushPortProvider(): Provider {
  return {
    provide: PushNotificationPort,
    useFactory: (): PushNotificationPort => {
      const provider = (process.env.PUSH_PROVIDER ?? 'mock').toLowerCase();
      if (provider === 'fcm') {
        // `buildFirebaseConfig` throws if the FIREBASE_* creds are missing —
        // a misconfigured `PUSH_PROVIDER=fcm` deployment fails at bootstrap
        // instead of silently dropping every push at dispatch time.
        return new FcmPushAdapter(buildFirebaseConfig());
      }
      return new MockPushAdapter();
    },
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
    // B22b T12 — weekly outbox-prune BullMQ queue. The scheduler upserts
    // the repeatable cron at OnApplicationBootstrap; the worker process
    // (`WorkerModule`) registers the same provider so the processor runs
    // there. API process can opt out via `OUTBOX_PRUNE_CRON=disabled`.
    BullModule.registerQueue({ name: OUTBOX_PRUNE_QUEUE }),
    ChildModule,
    GroupModule,
    UsersModule,
    // `WsBroadcaster` is provided globally by the process-side websocket
    // module: api uses `WebsocketModule` (imported by `AppModule`,
    // `@Global()` so its `WsBroadcaster` export reaches the dispatcher);
    // worker uses `WorkerWebsocketModule` (imported by `WorkerModule`,
    // also `@Global()`). The dispatcher's `WsBroadcaster` injection
    // resolves to the same `SocketIoWsBroadcaster` impl in both
    // processes — only the underlying `SocketIoServerProvider` differs.
    // Unit tests inject their own fake via `Test.overrideProvider`.
  ],
  controllers: [
    PushTokenController,
    NotificationController,
    NotificationPreferencesController,
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
    // Services.
    NotificationDispatcher,
    NotificationService,
    // B22b T12 — outbox-prune cron. The scheduler is gated behind
    // `OUTBOX_PRUNE_CRON !== 'disabled'`; the processor is harmless to
    // register here too (BullMQ workers attach to the queue by name and
    // duplicates across processes serialise on the queue, never doubling
    // work on a single repeatable tick).
    OutboxPruneProcessor,
    OutboxPruneScheduler,
  ],
  exports: [
    OutboxEventRepository,
    NotificationRepository,
    NotificationPreferenceRepository,
    PushTokenRepository,
    NotificationPort,
    PushNotificationPort,
    NotificationDispatcher,
    NotificationService,
    // Re-export BullMQ tokens so worker-side modules importing
    // NotificationModule can `@InjectQueue(OUTBOX_PRUNE_QUEUE)` without
    // a second `BullModule.registerQueue` call.
    BullModule,
  ],
})
export class NotificationModule {}
