import path from 'path';
import { Module } from '@nestjs/common';
import { existsSync } from 'fs';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { BullModule } from '@nestjs/bullmq';
import { ScheduleModule as NestScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HeaderResolver, I18nModule } from 'nestjs-i18n';
import { DataSource, DataSourceOptions } from 'typeorm';
import databaseConfig from './database/config/database.config';
import appConfig from './config/app.config';
import redisConfig from './redis/config/redis.config';
import authConfig from './modules/auth/config/auth.config';
import kaspiCryptoConfig from './shared-kernel/config/kaspi-crypto.config';
import { DbRoleCheckService } from './database/db-role-check.service';
import { TypeOrmConfigService } from './database/typeorm-config.service';
import { AllConfigType } from './config/config.type';
import { SharedKernelModule } from './shared-kernel/shared-kernel.module';
import { RedisModule } from './redis/redis.module';
import { HealthModule } from './modules/health/health.module';
import { AttendanceModule } from './modules/attendance/attendance.module';
import { AuthModule } from './modules/auth/auth.module';
import { BillingModule } from './modules/billing/billing.module';
import { BillingLifecycleBridgeModule } from './modules/billing/billing-lifecycle-bridge.module';
import { ContentModule } from './modules/content/content.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { DiagnosticsModule } from './modules/diagnostics/diagnostics.module';
import { CameraModule } from './modules/camera/camera.module';
import { ChildModule } from './modules/child/child.module';
import { EnrollmentModule } from './modules/enrollment/enrollment.module';
import { MealModule } from './modules/meal/meal.module';
import { GroupModule } from './modules/group/group.module';
import { IdentityQrModule } from './modules/identity-qr/identity-qr.module';
import { KindergartenModule } from './modules/kindergarten/kindergarten.module';
import { ParentKindergartenModule } from './modules/kindergarten/parent-kindergarten.module';
import { LocationModule } from './modules/location/location.module';
import { NotificationModule } from './modules/notification/notification.module';
import { PickupModule } from './modules/pickup/pickup.module';
import { ParentRequestModule } from './modules/parent-request/parent-request.module';
import { ScheduleModule } from './modules/schedule/schedule.module';
import { ScheduleRolloutModule } from './modules/schedule-rollout/schedule-rollout.module';
import { StaffModule } from './modules/staff/staff.module';
import { UsersModule } from './modules/users/users.module';
import { WebsocketModule } from './websocket/websocket.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { KindergartenScopeGuard } from './common/guards/kindergarten-scope.guard';
import { PendingRoleSelectGuard } from './common/guards/pending-role-select.guard';
import { TenantContextInterceptor } from './common/interceptors/tenant-context.interceptor';
import { DomainErrorFilter } from './common/filters/domain-error.filter';

const resolveI18nPath = (): string => {
  const compiledPath = path.join(__dirname, 'i18n');
  return existsSync(compiledPath)
    ? compiledPath
    : path.join(process.cwd(), 'src', 'i18n');
};

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [
        databaseConfig,
        appConfig,
        redisConfig,
        authConfig,
        kaspiCryptoConfig,
      ],
      envFilePath: ['.env'],
    }),
    TypeOrmModule.forRootAsync({
      useClass: TypeOrmConfigService,
      dataSourceFactory: async (options: DataSourceOptions) => {
        return new DataSource(options).initialize();
      },
    }),
    I18nModule.forRootAsync({
      useFactory: (configService: ConfigService<AllConfigType>) => ({
        fallbackLanguage: configService.getOrThrow('app.fallbackLanguage', {
          infer: true,
        }),
        loaderOptions: { path: resolveI18nPath(), watch: true },
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
    // BullMQ root connection (B13 T7a wiring fix): BillingModule registers a
    // BullMQ queue (`billing-monthly`) and a Processor worker. BullModule
    // requires `forRoot/forRootAsync` to be called once in the root module so
    // the shared Redis connection pool is available to all
    // `registerQueue`/`@Processor` consumers. Without this the Worker throws
    // "Worker requires a connection" on app init in both the API process and
    // the e2e test suite. The WorkerModule already carries this config for
    // the separate worker process; the API process (AppModule) needs it too.
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
            // BullMQ requires `maxRetriesPerRequest: null` so blocking
            // commands (XREAD/XREADGROUP) do not time out on idle queues.
            maxRetriesPerRequest: null,
          },
        };
      },
    }),
    // @nestjs/schedule enables the @Cron decorator pickup at app bootstrap.
    // After B9 T6, the weekly-rollout cron migrated to BullMQ (worker
    // process); no api-side @Cron handlers remain. The module is kept as a
    // placeholder so future api-resident timers can register without an
    // app-level wiring change. Renamed import to NestScheduleModule because
    // our business `ScheduleModule` already owns that name.
    NestScheduleModule.forRoot(),
    SharedKernelModule,
    RedisModule,
    HealthModule,
    UsersModule,
    AuthModule,
    StaffModule,
    KindergartenModule,
    LocationModule,
    GroupModule,
    CameraModule,
    ChildModule,
    ParentKindergartenModule,
    WebsocketModule,
    NotificationModule,
    IdentityQrModule,
    EnrollmentModule,
    MealModule,
    ScheduleModule,
    ScheduleRolloutModule,
    AttendanceModule,
    PickupModule,
    ParentRequestModule,
    BillingModule,
    // B21 T3: global bridge that overrides the default no-op
    // `BillingLifecyclePort` registered in `ChildModule` with the real
    // adapter that calls into `TariffAssignmentRepository`. Must come
    // after `BillingModule` so the underlying provider exists.
    BillingLifecycleBridgeModule,
    ContentModule,
    DashboardModule,
    DiagnosticsModule,
    // FINDINGS.md SP5 — `ServeStaticModule` removed. Uploaded media is now
    // served by `MediaController` (`GET /api/v1/media/:kgId/:yyyyMm/:filename`)
    // behind JwtAuthGuard + KindergartenScopeGuard + path-segment kg match.
    // ServeStaticModule hooks at the Express layer and bypasses every
    // NestJS guard, so it cannot be used for tenant-scoped files.
  ],
  providers: [
    // The interceptor establishes a tenant-scoped TypeORM transaction (with
    // SET LOCAL app.kindergarten_id / app.bypass_rls) for every request that
    // a guard has populated `req.tenant` on. Order matters: guards run before
    // interceptors, so JwtAuthGuard fills user, KindergartenScopeGuard fills
    // tenant, and finally TenantContextInterceptor wraps the handler.
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
    // Global filter that maps domain errors -> HTTP. Per-controller filters
    // are not needed because every error carries its own `code`.
    { provide: APP_FILTER, useClass: DomainErrorFilter },
    // Global guards. JwtAuthGuard short-circuits on @Public() handlers.
    // KindergartenScopeGuard derives tenant scope from req.user.
    // PendingRoleSelectGuard rejects pending sessions on non-allowlisted
    // handlers (the AllowPendingRoleSelect decorator opts in).
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: KindergartenScopeGuard },
    { provide: APP_GUARD, useClass: PendingRoleSelectGuard },
    // Fail-fast probe: aborts startup if the runtime DB role can bypass RLS
    // (SUPERUSER or BYPASSRLS). Migrations connect via a separate DataSource
    // and are unaffected. Escape hatch: DATABASE_BYPASS_ROLE_CHECK=true.
    DbRoleCheckService,
  ],
})
export class AppModule {}
