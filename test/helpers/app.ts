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

export async function truncateAll(dataSource: DataSource): Promise<void> {
  // Tenant-scoped tables (staff_members, refresh_tokens) FORCE row-level
  // security on the runtime role, so a plain TRUNCATE issued without
  // app.bypass_rls fails. Wrap in a tx with the GUC set so cleanup runs as
  // an "operator" regardless of the connecting role.
  await dataSource.transaction(async (m) => {
    await m.query(`SET LOCAL app.bypass_rls = 'true'`);
    await m.query(
      `TRUNCATE TABLE notification_outbox, notifications, notification_preferences, push_tokens, saas_refresh_tokens, saas_users, timeline_entries, attendance_events, child_daily_status, schedule_week_snapshots, activity_events, schedule_template_slots, schedule_templates, meal_items, meal_plans, child_group_history, child_guardians, children, group_mentors, groups, cameras, locations, staff_members, refresh_tokens, users, kindergartens RESTART IDENTITY CASCADE`,
    );
  });
}

export async function flushRedis(redis: RedisService): Promise<void> {
  await redis.flushdb();
}
