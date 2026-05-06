import 'reflect-metadata';
import type { Server } from 'node:http';
import {
  ClassSerializerInterceptor,
  INestApplication,
  ValidationPipe,
  VersioningType,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '@/app.module';
import { RedisIoAdapter } from '@/common/websocket/redis-io.adapter';
import { SmsPort } from '@/modules/auth/sms.port';
import { MockSmsAdapter } from '@/modules/auth/infrastructure/adapters/mock-sms.adapter';
import { RedisService } from '@/redis/redis.service';
import { AllConfigType } from '@/config/config.type';
import validationOptions from '@/utils/validation-options';
import { ResolvePromisesInterceptor } from '@/utils/serializer.interceptor';

export interface TestApp {
  app: INestApplication;
  server: Server;
  dataSource: DataSource;
  redis: RedisService;
  sms: TestSmsAdapter;
}

export interface CreateTestAppOptions {
  /**
   * Wire the socket.io Redis pub/sub adapter so WS-related e2e tests can
   * assert end-to-end fan-out. Default `false` — leaving WS disabled keeps
   * non-WS test suites lean (no extra Redis pub/sub clients to clean up).
   */
  withWebsockets?: boolean;
}

/**
 * MockSmsAdapter variant that captures the most recent SMS so tests can
 * assert on (or extract) the OTP code that was about to be sent.
 */
export class TestSmsAdapter extends MockSmsAdapter {
  lastSent: { phone: string; message: string } | null = null;
  log: { phone: string; message: string }[] = [];

  override send(phone: string, message: string) {
    this.lastSent = { phone, message };
    this.log.push({ phone, message });
    return super.send(phone, message);
  }
}

export async function createTestApp(
  options: CreateTestAppOptions = {},
): Promise<TestApp> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(SmsPort)
    .useClass(TestSmsAdapter)
    .compile();

  const app = moduleRef.createNestApplication({ bufferLogs: true });
  const configService = app.get(ConfigService<AllConfigType>);
  app.setGlobalPrefix(
    configService.getOrThrow('app.apiPrefix', { infer: true }),
    { exclude: ['/'] },
  );
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(new ValidationPipe(validationOptions));
  app.useGlobalInterceptors(
    new ResolvePromisesInterceptor(),
    new ClassSerializerInterceptor(app.get(Reflector)),
  );

  if (options.withWebsockets) {
    const wsAdapter = new RedisIoAdapter(app);
    await wsAdapter.connectToRedis();
    app.useWebSocketAdapter(wsAdapter);
  }

  await app.init();

  const dataSource = app.get(DataSource);
  const redis = app.get(RedisService);
  const sms = app.get(SmsPort) as TestSmsAdapter;
  return { app, server: app.getHttpServer() as Server, dataSource, redis, sms };
}

/**
 * Lazily-built DataSource that connects as the migration role
 * (DATABASE_MIGRATION_USERNAME, SUPERUSER) — required because the runtime
 * role (`shyraq_app`) is intentionally NOT granted TRUNCATE (RLS does not
 * cover TRUNCATE; see `RevokeTruncateFromAppRole` migration). Tests that
 * need to wipe tables between cases run cleanup through this connection.
 */
let cleanupDataSource: DataSource | null = null;

async function getCleanupDataSource(): Promise<DataSource> {
  if (cleanupDataSource && cleanupDataSource.isInitialized) {
    return cleanupDataSource;
  }
  const ds = new DataSource({
    type: process.env.DATABASE_TYPE as 'postgres',
    host: process.env.DATABASE_HOST,
    port: process.env.DATABASE_PORT
      ? parseInt(process.env.DATABASE_PORT, 10)
      : 5432,
    username:
      process.env.DATABASE_MIGRATION_USERNAME ?? process.env.DATABASE_USERNAME,
    password:
      process.env.DATABASE_MIGRATION_PASSWORD ?? process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
    // No entities/migrations needed — only used for TRUNCATE.
    entities: [],
    extra: { max: 2 },
  });
  await ds.initialize();
  cleanupDataSource = ds;
  return ds;
}

export async function closeCleanupDataSource(): Promise<void> {
  if (cleanupDataSource && cleanupDataSource.isInitialized) {
    await cleanupDataSource.destroy();
    cleanupDataSource = null;
  }
}

export async function truncateAll(_dataSource: DataSource): Promise<void> {
  // The first arg used to be the app DataSource, but the runtime role no
  // longer has TRUNCATE. We keep the signature for compatibility and route
  // through a privileged cleanup DataSource. RLS is still bypassed inside
  // the tx for FORCE-RLS tables.
  const ds = await getCleanupDataSource();
  await ds.transaction(async (m) => {
    await m.query(`SET LOCAL app.bypass_rls = 'true'`);
    await m.query(
      `TRUNCATE TABLE parent_request_messages, parent_requests, pickup_requests, trusted_people, user_qr_tokens, notification_outbox, notifications, notification_preferences, push_tokens, saas_refresh_tokens, saas_users, timeline_entries, attendance_events, child_daily_status, schedule_week_snapshots, activity_events, schedule_template_slots, schedule_templates, meal_items, meal_plans, child_group_history, child_guardians, children, group_mentors, groups, cameras, locations, staff_members, refresh_tokens, users, kindergartens RESTART IDENTITY CASCADE`,
    );
  });
}

export async function flushRedis(redis: RedisService): Promise<void> {
  await redis.flushdb();
}
