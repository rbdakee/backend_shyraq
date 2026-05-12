import path from 'path';
import { existsSync } from 'fs';
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HeaderResolver, I18nModule } from 'nestjs-i18n';
import { DataSource, DataSourceOptions } from 'typeorm';
import appConfig from '@/config/app.config';
import { AllConfigType } from '@/config/config.type';
import databaseConfig from '@/database/config/database.config';
import { TypeOrmConfigService } from '@/database/typeorm-config.service';
import { AuthModule } from '@/modules/auth/auth.module';
import authConfig from '@/modules/auth/config/auth.config';
import { BillingModule } from '@/modules/billing/billing.module';
import { BillingLifecycleBridgeModule } from '@/modules/billing/billing-lifecycle-bridge.module';
import { ChildModule } from '@/modules/child/child.module';
import { GroupModule } from '@/modules/group/group.module';
import { KindergartenModule } from '@/modules/kindergarten/kindergarten.module';
import { MealModule } from '@/modules/meal/meal.module';
import { NotificationModule } from '@/modules/notification/notification.module';
import {
  OutboxPollerProcessor,
  OUTBOX_POLLER_QUEUE,
} from '@/modules/notification/outbox-poller.processor';
import { ScheduleModule } from '@/modules/schedule/schedule.module';
import { ScheduleRolloutModule } from '@/modules/schedule-rollout/schedule-rollout.module';
import {
  WeeklyRolloutProcessor,
  WEEKLY_ROLLOUT_QUEUE,
} from '@/modules/schedule-rollout/weekly-rollout.processor';
import { RedisModule } from '@/redis/redis.module';
import redisConfig from '@/redis/config/redis.config';
import { SharedKernelModule } from '@/shared-kernel/shared-kernel.module';
import { WorkerJobSchedulerService } from './worker-job-scheduler.service';
import { WorkerWebsocketModule } from './worker-websocket.module';

/**
 * Resolve the i18n locale path the same way `app.module.ts` does. The
 * worker doesn't render i18n strings itself, but `I18nModule` is a
 * transitive dependency of business modules pulled in via
 * `NotificationModule` / `ScheduleRolloutModule`, so the loader must point
 * at a real directory.
 */
const resolveI18nPath = (): string => {
  const compiledPath = path.join(__dirname, '..', 'i18n');
  return existsSync(compiledPath)
    ? compiledPath
    : path.join(process.cwd(), 'src', 'i18n');
};

/**
 * WorkerModule — Nest module loaded by `src/main.worker.ts`. Mirrors the
 * api's `AppModule` for the subset of providers the worker needs:
 *
 * - TypeORM with the same runtime app role (NOBYPASSRLS). The worker uses
 *   `SET LOCAL app.bypass_rls = 'true'` inside its dispatch transaction
 *   instead of relying on a privileged DB role.
 * - BullMQ root config wired against Redis using the same env vars the api
 *   uses (`REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD`).
 * - Two queues: `notifications-outbox` (poller) and `schedule-rollout`
 *   (weekly cron).
 * - `NotificationModule` + `ScheduleRolloutModule` for the dispatcher and
 *   rollout service. `NotificationModule` is `@Global()` so its providers
 *   are reachable inside the processors without an explicit import below;
 *   we list it anyway for explicitness.
 * - WebSocket fan-out: the worker imports
 *   `WsBroadcastModule.forProvider(WorkerSocketIoServerProvider)` instead
 *   of the api-side `WebsocketModule`. The `SocketIoWsBroadcaster` resolves
 *   `SocketIoServerProvider` to the publisher-only Server inside
 *   `WorkerSocketIoServerProvider`, so emits flow through Redis pub/sub
 *   to api processes that own real client sockets.
 *
 * Crucially the worker NEVER imports `AppModule` — that would pull in the
 * REST controllers, the WS gateway, and the JWT/tenant-scope guards, all
 * of which assume an HTTP server is bound. Instead it composes the same
 * leaf modules à la carte.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, appConfig, redisConfig, authConfig],
      envFilePath: ['.env'],
    }),
    TypeOrmModule.forRootAsync({
      useClass: TypeOrmConfigService,
      dataSourceFactory: async (options?: DataSourceOptions) => {
        if (!options) {
          throw new Error('worker_module_typeorm_options_missing');
        }
        return new DataSource(options).initialize();
      },
    }),
    I18nModule.forRootAsync({
      useFactory: (configService: ConfigService<AllConfigType>) => ({
        fallbackLanguage: configService.getOrThrow('app.fallbackLanguage', {
          infer: true,
        }),
        loaderOptions: { path: resolveI18nPath(), watch: false },
      }),
      resolvers: [
        {
          use: HeaderResolver,
          useFactory: (configService: ConfigService<AllConfigType>) => {
            return [configService.get('app.headerLanguage', { infer: true })];
          },
          inject: [ConfigService],
        },
      ],
      imports: [ConfigModule],
      inject: [ConfigService],
    }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService<AllConfigType>) => {
        const host = configService.getOrThrow('redis.host', { infer: true });
        const port = configService.getOrThrow('redis.port', { infer: true });
        const password = configService.get('redis.password', { infer: true });
        return {
          connection: {
            host,
            port,
            password: password ? password : undefined,
            // BullMQ requires `maxRetriesPerRequest` to be `null` so blocking
            // commands (XREAD/XREADGROUP) do not error out on slow ticks.
            maxRetriesPerRequest: null,
          },
        };
      },
    }),
    BullModule.registerQueue(
      { name: OUTBOX_POLLER_QUEUE },
      { name: WEEKLY_ROLLOUT_QUEUE },
    ),
    SharedKernelModule,
    RedisModule,
    // Business modules. Order mirrors AppModule for predictability when
    // diffing the two graphs. AuthModule is `@Global()` and exports
    // `SmsPort` / `JwtTokenPort` / `TokenBlocklistPort` — pulled in so
    // KindergartenService (via KindergartenModule) and any future
    // dispatcher path that touches auth can resolve those ports. The
    // controllers AuthModule registers are inert under
    // `createApplicationContext` (no HTTP server is bound).
    AuthModule,
    KindergartenModule,
    GroupModule,
    ChildModule,
    // B21 T3: worker hosts the ProRataRefundProcessor (BillingModule) and
    // imports ChildModule for the lifecycle queue. The global lifecycle
    // bridge module wires the real `BillingLifecyclePort` adapter so
    // worker-side flows that touch `ChildService.archive` (e.g. cron-driven
    // archives) see the same binding as the API process.
    BillingModule,
    BillingLifecycleBridgeModule,
    // `WorkerWebsocketModule` is the worker's counterpart of the api's
    // `WebsocketModule`. It provides the same global tokens
    // (`WsBroadcaster` + `SocketIoServerProvider`) but bound to a
    // publisher-only socket.io Server attached to the Redis pub/sub
    // adapter — no `NotificationGateway`, no `AuthModule` globals
    // required. The dispatcher inside `NotificationModule` resolves
    // `WsBroadcaster` from this global module without an explicit
    // import.
    WorkerWebsocketModule,
    NotificationModule,
    MealModule,
    ScheduleModule,
    ScheduleRolloutModule,
  ],
  providers: [
    OutboxPollerProcessor,
    WeeklyRolloutProcessor,
    WorkerJobSchedulerService,
  ],
})
export class WorkerModule {}
