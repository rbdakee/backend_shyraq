import { Module } from '@nestjs/common';
import path from 'path';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { HeaderResolver, I18nModule } from 'nestjs-i18n';
import { DataSource, DataSourceOptions } from 'typeorm';
import databaseConfig from './database/config/database.config';
import appConfig from './config/app.config';
import redisConfig from './redis/config/redis.config';
import authConfig from './modules/auth/config/auth.config';
import { TypeOrmConfigService } from './database/typeorm-config.service';
import { AllConfigType } from './config/config.type';
import { SharedKernelModule } from './shared-kernel/shared-kernel.module';
import { RedisModule } from './redis/redis.module';
import { HealthModule } from './modules/health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { CameraModule } from './modules/camera/camera.module';
import { ChildModule } from './modules/child/child.module';
import { GroupModule } from './modules/group/group.module';
import { KindergartenModule } from './modules/kindergarten/kindergarten.module';
import { LocationModule } from './modules/location/location.module';
import { StaffModule } from './modules/staff/staff.module';
import { UsersModule } from './modules/users/users.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { KindergartenScopeGuard } from './common/guards/kindergarten-scope.guard';
import { PendingRoleSelectGuard } from './common/guards/pending-role-select.guard';
import { TenantContextInterceptor } from './common/interceptors/tenant-context.interceptor';
import { DomainErrorFilter } from './common/filters/domain-error.filter';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, appConfig, redisConfig, authConfig],
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
        loaderOptions: { path: path.join(__dirname, '/i18n/'), watch: true },
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
  ],
})
export class AppModule {}
