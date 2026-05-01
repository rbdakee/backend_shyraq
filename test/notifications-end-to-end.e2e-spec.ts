/**
 * B9 T9 — notifications end-to-end: full HTTP→DB→worker→client flow.
 *
 * Covers two logical test groups in one file because both groups share the
 * same api + worker context pair (booting two Nest contexts is expensive;
 * keeping them alive for the duration of the suite avoids a ~15 s overhead
 * per group).
 *
 * GROUP 1 — HTTP + outbox flow (no WS client):
 *   A. Register parent JWT + push token.
 *   B. Trigger attendance check-in (staff JWT, different actor).
 *   C. Assert outbox row status=pending.
 *   D. Drain worker via direct OutboxPollerProcessor.process(fakeJob).
 *   E. Assert outbox row status=dispatched.
 *   F. Assert notifications-history row created for the parent.
 *   G. Assert MockPushAdapter.getCalls() recorded a call to the parent's token.
 *   H. Preferences-off (push disabled): trigger → history row YES, push NO.
 *   I. Both off: trigger → NO history row, NO push.
 *
 * GROUP 2 — WebSocket broadcast flow:
 *   J. Parent connects socket.io-client with JWT.
 *   K. Assert `connected` event with rooms [user:{id}, child:{id}].
 *   L. Trigger check-in via HTTP; drain worker directly.
 *   M. Assert client socket received `attendance.checkin` event with correct
 *      child_id in the payload.
 *   N. Disconnect, cleanup.
 *
 * Worker drain: direct `OutboxPollerProcessor.process(fakeJob)` — deterministic
 * and fast (<100 ms per drain vs 2 s BullMQ tick cadence).
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { NestFactory } from '@nestjs/core';
import { INestApplicationContext } from '@nestjs/common';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import { DataSource } from 'typeorm';
import type { Job } from 'bullmq';
import { PushNotificationPort } from '@/shared-kernel/domain/push-notification.port';
import { MockPushAdapter } from '@/shared-kernel/infrastructure/adapters/mock-push.adapter';
import { OutboxPollerProcessor } from '@/modules/notification/outbox-poller.processor';
import { WorkerModule } from '@/worker/worker.module';
import { createTestApp, flushRedis, TestApp, truncateAll } from './helpers/app';

// ── constants ────────────────────────────────────────────────────────────────

const SUPER_ADMIN_EMAIL = 'super-notif-e2e@shyraq.test';
const SUPER_ADMIN_PASSWORD = 'admin12345';

// Fake BullMQ job — the processor only uses job.name internally for logging;
// the real work is triggered by calling process() directly.
const FAKE_JOB = { name: 'poll', data: {} } as Job;

// ── types ────────────────────────────────────────────────────────────────────

interface CreatedKgResp {
  kindergarten: { id: string; slug: string };
  staff_member: { id: string; user_id: string };
  user: { id: string; phone: string };
}

// ── suite ────────────────────────────────────────────────────────────────────

describe('B9 notifications end-to-end (e2e)', () => {
  let apiCtx: TestApp;
  let workerApp: INestApplicationContext;
  let processor: OutboxPollerProcessor;
  let pushAdapter: MockPushAdapter;
  let jwtService: JwtService;
  let jwtSecret: string;
  let serverPort: number;
  let baseUrl: string;
  let saAccess: string;

  // ── lifecycle ─────────────────────────────────────────────────────────────

  beforeAll(async () => {
    // 1. Api process (HTTP + WS).
    apiCtx = await createTestApp({ withWebsockets: true });
    await apiCtx.app.listen(0);
    const addr = apiCtx.server.address();
    if (!addr || typeof addr === 'string') {
      throw new Error('cannot resolve ephemeral port');
    }
    serverPort = addr.port;
    baseUrl = `http://127.0.0.1:${serverPort}`;

    const config = apiCtx.app.get(ConfigService);
    jwtSecret = config.getOrThrow<string>('auth.jwtAccessSecret');
    jwtService = apiCtx.app.get(JwtService);

    // 2. Worker process (BullMQ + dispatcher + WS broadcaster).
    workerApp = await NestFactory.createApplicationContext(WorkerModule, {
      logger: false,
    });
    processor = workerApp.get(OutboxPollerProcessor);

    // Push adapter from the WORKER container — the dispatcher runs inside the
    // worker process, so push calls are recorded on the worker's MockPushAdapter
    // instance, not the api's. Both are singletons within their own DI scope.
    pushAdapter = workerApp.get(PushNotificationPort) as MockPushAdapter;
  }, 60_000);

  afterAll(async () => {
    await truncateAll(apiCtx.dataSource);
    await flushRedis(apiCtx.redis);
    await apiCtx.app.close();
    await workerApp.close();
  }, 30_000);

  beforeEach(async () => {
    await truncateAll(apiCtx.dataSource);
    await flushRedis(apiCtx.redis);
    apiCtx.sms.lastSent = null;
    apiCtx.sms.log.length = 0;
    pushAdapter.clearCalls();
    await seedSuperAdmin();
    saAccess = await loginSuperAdmin();
  });

  // ── local helpers ─────────────────────────────────────────────────────────

  async function seedSuperAdmin(): Promise<void> {
    const hash = await bcrypt.hash(SUPER_ADMIN_PASSWORD, 4);
    await apiCtx.dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      await m.query(
        `INSERT INTO saas_users (id, email, full_name, password_hash, role, is_active)
         VALUES ($1, $2, 'SA-Notif', $3, 'super_admin', true)`,
        [randomUUID(), SUPER_ADMIN_EMAIL, hash],
      );
    });
  }

  async function loginSuperAdmin(): Promise<string> {
    const res = await request(apiCtx.server)
      .post('/api/v1/saas/auth/login')
      .send({
        email: SUPER_ADMIN_EMAIL,
        password: SUPER_ADMIN_PASSWORD,
      })
      .expect(200);
    return res.body.access_token as string;
  }

  async function createKgWithAdmin(slug: string, phone: string) {
    const res = await request(apiCtx.server)
      .post('/api/v1/saas/kindergartens')
      .set('Authorization', `Bearer ${saAccess}`)
      .send({
        name: 'Notif-Test KG',
        slug,
        admin: { full_name: 'Admin', phone },
      })
      .expect(201);
    const body = res.body as CreatedKgResp;
    const adminToken = await mintToken({
      sub: body.user.id,
      role: 'admin',
      kindergartenId: body.kindergarten.id,
    });
    const staffToken = await mintToken({
      sub: body.user.id,
      role: 'mentor',
      kindergartenId: body.kindergarten.id,
    });
    return {
      kgId: body.kindergarten.id,
      userId: body.user.id,
      adminToken,
      staffToken,
    };
  }

  async function mintToken(opts: {
    sub: string;
    role: string;
    kindergartenId: string;
  }): Promise<string> {
    return jwtService.signAsync(
      {
        sub: opts.sub,
        role: opts.role,
        kindergarten_id: opts.kindergartenId,
        jti: randomUUID(),
      },
      { secret: jwtSecret, expiresIn: '1h' },
    );
  }

  async function seedUser(phone: string): Promise<string> {
    const id = randomUUID();
    await apiCtx.dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      await m.query(
        `INSERT INTO users (id, phone, full_name) VALUES ($1, $2, 'Notif Parent')`,
        [id, phone],
      );
    });
    return id;
  }

  async function seedApprovedGuardian(
    childId: string,
    userId: string,
    kgId: string,
  ): Promise<void> {
    await apiCtx.dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      await m.query(
        `INSERT INTO child_guardians
           (id, kindergarten_id, child_id, user_id, role, status,
            can_pickup, approved_by, approved_at)
         VALUES ($1, $2, $3, $4, 'primary', 'approved', false, $4, now())`,
        [randomUUID(), kgId, childId, userId],
      );
    });
  }

  async function createChild(
    adminToken: string,
    payload: { full_name: string; date_of_birth: string },
  ): Promise<string> {
    const res = await request(apiCtx.server)
      .post('/api/v1/children')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(payload)
      .expect(201);
    return res.body.id as string;
  }

  // ── GROUP 1 — HTTP + outbox + push flow ────────────────────────────────────

  describe('GROUP 1 — HTTP outbox + push flow', () => {
    it('check-in triggers outbox row (pending), worker drains it to dispatched, history row + push call created (Scenario A-G)', async () => {
      const kg = await createKgWithAdmin('notif-ag', '+77040000001');
      const childId = await createChild(kg.adminToken, {
        full_name: 'AG-Child',
        date_of_birth: '2022-01-10',
      });

      // Seed parent with an approved guardian link.
      const parentUserId = await seedUser('+77040000011');
      await seedApprovedGuardian(childId, parentUserId, kg.kgId);

      const parentToken = await mintToken({
        sub: parentUserId,
        role: 'parent',
        kindergartenId: kg.kgId,
      });

      // Register a push token for the parent.
      const pushTokenRes = await request(apiCtx.server)
        .post('/api/v1/push-tokens')
        .set('Authorization', `Bearer ${parentToken}`)
        .send({
          token: 'fake-device-token-ag',
          platform: 'android',
          app_version: '1.0.0',
          device_id: 'device-ag-01',
        })
        .expect(201);
      expect(pushTokenRes.body.token).toBe('fake-device-token-ag');

      // Trigger check-in (staff actor).
      await request(apiCtx.server)
        .post('/api/v1/staff/attendance/check-in')
        .set('Authorization', `Bearer ${kg.staffToken}`)
        .send({ childId })
        .expect(201);

      // Verify outbox row was created with status=pending.
      // The api's outbox repo shares the same DB schema — query via the
      // worker's DataSource (which uses bypass_rls already in the poller TX)
      // or via a raw bypass tx on the api side.
      const workerDs = workerApp.get(DataSource);
      const pendingRows = await workerDs.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        return m.query<{ id: string; status: string; event_key: string }[]>(
          `SELECT id, status, event_key FROM notification_outbox
            WHERE event_key = 'attendance.checkin' ORDER BY created_at DESC LIMIT 1`,
        );
      });

      expect(pendingRows.length).toBe(1);
      const outboxId = pendingRows[0].id;
      expect(pendingRows[0].status).toBe('pending');
      expect(pendingRows[0].event_key).toBe('attendance.checkin');

      // Drain worker directly — deterministic, no BullMQ tick wait.
      await processor.process(FAKE_JOB);

      // Assert outbox row flipped to dispatched.
      const afterDrain = await workerDs.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        return m.query<{ status: string; dispatched_at: string | null }[]>(
          `SELECT status, dispatched_at FROM notification_outbox WHERE id = $1`,
          [outboxId],
        );
      });
      expect(afterDrain[0].status).toBe('dispatched');
      expect(afterDrain[0].dispatched_at).not.toBeNull();

      // Assert notification history row created for the parent (filter by
      // event_key since check-in may also trigger other notifications such as
      // `timeline.entry_created`).
      const historyRows = await workerDs.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        return m.query<{ id: string; event_key: string }[]>(
          `SELECT id, event_key FROM notifications
            WHERE user_id = $1 AND event_key = 'attendance.checkin'`,
          [parentUserId],
        );
      });
      expect(historyRows.length).toBeGreaterThanOrEqual(1);
      expect(historyRows[0].event_key).toBe('attendance.checkin');

      // Assert MockPushAdapter recorded a push call to the parent's token.
      const calls = pushAdapter.getCalls();
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const callForParent = calls.find((c) => c.target.userId === parentUserId);
      expect(callForParent).toBeDefined();
      expect(
        callForParent!.target.tokens.some(
          (t) => t.token === 'fake-device-token-ag',
        ),
      ).toBe(true);
    });

    it('preference push_enabled=false suppresses push but keeps history row (Scenario H)', async () => {
      const kg = await createKgWithAdmin('notif-h', '+77040000002');
      const childId = await createChild(kg.adminToken, {
        full_name: 'H-Child',
        date_of_birth: '2022-02-10',
      });

      const parentUserId = await seedUser('+77040000012');
      await seedApprovedGuardian(childId, parentUserId, kg.kgId);

      const parentToken = await mintToken({
        sub: parentUserId,
        role: 'parent',
        kindergartenId: kg.kgId,
      });

      // Register push token.
      await request(apiCtx.server)
        .post('/api/v1/push-tokens')
        .set('Authorization', `Bearer ${parentToken}`)
        .send({ token: 'fake-device-token-h', platform: 'ios' })
        .expect(201);

      // Disable push for attendance.checkin (keep in_app=true). Also disable
      // push for timeline.entry_created because an attendance check-in writes
      // a timeline entry too, which would otherwise generate a second push call
      // and make the assertion ambiguous.
      await request(apiCtx.server)
        .patch('/api/v1/notifications/preferences')
        .set('Authorization', `Bearer ${parentToken}`)
        .send({
          preferences: [
            {
              event_key: 'attendance.checkin',
              push_enabled: false,
              in_app_enabled: true,
            },
            {
              event_key: 'timeline.entry_created',
              push_enabled: false,
              in_app_enabled: false,
            },
          ],
        })
        .expect(200);

      // Trigger check-in.
      await request(apiCtx.server)
        .post('/api/v1/staff/attendance/check-in')
        .set('Authorization', `Bearer ${kg.staffToken}`)
        .send({ childId })
        .expect(201);

      // Drain.
      await processor.process(FAKE_JOB);

      // History row SHOULD exist.
      const workerDs = workerApp.get(DataSource);
      const historyRows = await workerDs.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        return m.query<{ id: string }[]>(
          `SELECT id FROM notifications WHERE user_id = $1 AND event_key = 'attendance.checkin'`,
          [parentUserId],
        );
      });
      expect(historyRows.length).toBeGreaterThanOrEqual(1);

      // No push call for any event (both attendance.checkin and
      // timeline.entry_created have push disabled above).
      const calls = pushAdapter.getCalls();
      const callForParent = calls.find((c) => c.target.userId === parentUserId);
      expect(callForParent).toBeUndefined();
    });

    it('both preferences off: no history row AND no push call (Scenario I)', async () => {
      const kg = await createKgWithAdmin('notif-i', '+77040000003');
      const childId = await createChild(kg.adminToken, {
        full_name: 'I-Child',
        date_of_birth: '2022-03-10',
      });

      const parentUserId = await seedUser('+77040000013');
      await seedApprovedGuardian(childId, parentUserId, kg.kgId);

      const parentToken = await mintToken({
        sub: parentUserId,
        role: 'parent',
        kindergartenId: kg.kgId,
      });

      // Register push token.
      await request(apiCtx.server)
        .post('/api/v1/push-tokens')
        .set('Authorization', `Bearer ${parentToken}`)
        .send({ token: 'fake-device-token-i', platform: 'android' })
        .expect(201);

      // Disable both push and in_app for attendance.checkin AND
      // timeline.entry_created (check-in writes a timeline entry too,
      // so we mute both to assert no notifications at all for this parent).
      await request(apiCtx.server)
        .patch('/api/v1/notifications/preferences')
        .set('Authorization', `Bearer ${parentToken}`)
        .send({
          preferences: [
            {
              event_key: 'attendance.checkin',
              push_enabled: false,
              in_app_enabled: false,
            },
            {
              event_key: 'timeline.entry_created',
              push_enabled: false,
              in_app_enabled: false,
            },
          ],
        })
        .expect(200);

      // Trigger check-in.
      await request(apiCtx.server)
        .post('/api/v1/staff/attendance/check-in')
        .set('Authorization', `Bearer ${kg.staffToken}`)
        .send({ childId })
        .expect(201);

      // Drain.
      await processor.process(FAKE_JOB);

      const workerDs = workerApp.get(DataSource);

      // NO history row.
      const historyRows = await workerDs.transaction(async (m) => {
        await m.query(`SET LOCAL app.bypass_rls = 'true'`);
        return m.query<{ id: string }[]>(
          `SELECT id FROM notifications WHERE user_id = $1 AND event_key = 'attendance.checkin'`,
          [parentUserId],
        );
      });
      expect(historyRows.length).toBe(0);

      // NO push call.
      const calls = pushAdapter.getCalls();
      const callForParent = calls.find((c) => c.target.userId === parentUserId);
      expect(callForParent).toBeUndefined();
    });
  });

  // ── GROUP 2 — WebSocket broadcast flow ────────────────────────────────────

  describe('GROUP 2 — WebSocket broadcast flow', () => {
    /**
     * Wait for a `connected` event from the socket or reject on connect_error /
     * auth_error / timeout.
     */
    function awaitConnected(
      socket: ClientSocket,
      timeoutMs = 8000,
    ): Promise<{ user_id: string; rooms: string[] }> {
      return new Promise((resolve, reject) => {
        const t = setTimeout(
          () => reject(new Error('connected_timeout')),
          timeoutMs,
        );
        socket.once(
          'connected',
          (data: { user_id: string; rooms: string[] }) => {
            clearTimeout(t);
            resolve(data);
          },
        );
        socket.once('connect_error', (err: Error) => {
          clearTimeout(t);
          reject(err);
        });
        socket.once('auth_error', (err: { message: string }) => {
          clearTimeout(t);
          reject(new Error(err.message));
        });
      });
    }

    /**
     * Wait for an `attendance.checkin` event on the socket, or reject on
     * timeout.
     */
    function awaitCheckinEvent(
      socket: ClientSocket,
      timeoutMs = 8000,
    ): Promise<Record<string, unknown>> {
      return new Promise((resolve, reject) => {
        const t = setTimeout(
          () => reject(new Error('checkin_event_timeout')),
          timeoutMs,
        );
        socket.once(
          'attendance.checkin',
          (payload: Record<string, unknown>) => {
            clearTimeout(t);
            resolve(payload);
          },
        );
      });
    }

    it('parent receives attendance.checkin WS event after worker drains outbox (Scenario J-N)', async () => {
      const kg = await createKgWithAdmin('notif-ws', '+77040000004');
      const childId = await createChild(kg.adminToken, {
        full_name: 'WS-Child',
        date_of_birth: '2022-04-10',
      });

      const parentUserId = await seedUser('+77040000014');
      await seedApprovedGuardian(childId, parentUserId, kg.kgId);

      const parentToken = await mintToken({
        sub: parentUserId,
        role: 'parent',
        kindergartenId: kg.kgId,
      });

      // Connect socket.io-client.
      const socket = ioClient(baseUrl, {
        path: '/ws',
        auth: { token: parentToken },
        transports: ['websocket'],
        forceNew: true,
        reconnection: false,
      });

      try {
        // Wait for the `connected` event (gateway auto-subscribes).
        const ack = await awaitConnected(socket);
        expect(ack.user_id).toBe(parentUserId);
        expect(ack.rooms).toEqual(
          expect.arrayContaining([`user:${parentUserId}`, `child:${childId}`]),
        );

        // Set up the listener BEFORE triggering the check-in so no race.
        const eventPromise = awaitCheckinEvent(socket);

        // Trigger check-in via HTTP.
        await request(apiCtx.server)
          .post('/api/v1/staff/attendance/check-in')
          .set('Authorization', `Bearer ${kg.staffToken}`)
          .send({ childId })
          .expect(201);

        // Drain outbox directly — no BullMQ tick wait.
        await processor.process(FAKE_JOB);

        // Assert client received the WS event.
        const payload = await eventPromise;
        expect(payload).toBeDefined();
        // The dispatcher broadcasts to `user:{userId}` so the child_id is
        // in the `data` sub-object from the template.
        expect((payload as { data?: { childId?: string } }).data?.childId).toBe(
          childId,
        );
      } finally {
        socket.disconnect();
      }
    });
  });
});
