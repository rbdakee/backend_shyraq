/**
 * B9 T5 websocket gateway e2e — exercises the handshake-auth + auto-subscribe
 * flow end-to-end against a real socket.io server backed by the Redis
 * pub/sub adapter (same setup as production).
 *
 * Scenarios covered:
 *   - happy path: parent JWT in handshake.auth.token → connected event with
 *     rooms [user:{uid}, child:{cid}] and a child-room broadcast reaches
 *     the client.
 *   - missing token → connect_error + disconnect.
 *   - invalid token → connect_error + disconnect.
 *
 * The full outbox → dispatcher → broadcaster path is covered by T9
 * (notifications.e2e-spec.ts). T5 only verifies the gateway side.
 */
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import { NotificationGateway } from '@/websocket/notification.gateway';
import { TokenBlocklistPort } from '@/modules/auth/token-blocklist.port';
import { createTestApp, flushRedis, TestApp, truncateAll } from './helpers/app';

const SUPER_ADMIN_EMAIL = 'super-ws@shyraq.test';
const SUPER_ADMIN_PASSWORD = 'admin12345';

interface CreatedKgResp {
  kindergarten: { id: string; slug: string };
  staff_member: { id: string; user_id: string };
  user: { id: string; phone: string };
}

describe('B9 websocket gateway (e2e)', () => {
  let ctx: TestApp;
  let saAccess: string;
  let jwtService: JwtService;
  let jwtSecret: string;
  let serverPort: number;
  let baseUrl: string;

  // ── helpers ───────────────────────────────────────────────────────────────

  async function mintParentAccess(opts: {
    sub: string;
    kindergartenId: string;
  }): Promise<string> {
    return jwtService.signAsync(
      {
        sub: opts.sub,
        role: 'parent',
        kindergarten_id: opts.kindergartenId,
        jti: randomUUID(),
      },
      { secret: jwtSecret, expiresIn: '1h' },
    );
  }

  async function seedSuperAdmin(): Promise<void> {
    const hash = await bcrypt.hash(SUPER_ADMIN_PASSWORD, 4);
    await ctx.dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      await m.query(
        `INSERT INTO saas_users (id, email, full_name, password_hash, role, is_active)
         VALUES ($1, $2, 'SA', $3, 'super_admin', true)`,
        [randomUUID(), SUPER_ADMIN_EMAIL, hash],
      );
    });
  }

  async function loginSuperAdmin(): Promise<string> {
    const res = await request(ctx.server)
      .post('/api/v1/saas/auth/login')
      .send({ email: SUPER_ADMIN_EMAIL, password: SUPER_ADMIN_PASSWORD })
      .expect(200);
    return res.body.access_token as string;
  }

  async function createKgWithAdmin(
    slug: string,
    phone: string,
  ): Promise<{ kgId: string; adminUserId: string; adminToken: string }> {
    const res = await request(ctx.server)
      .post('/api/v1/saas/kindergartens')
      .set('Authorization', `Bearer ${saAccess}`)
      .send({
        name: 'WS-Test KG',
        slug,
        admin: { full_name: 'Admin', phone },
      })
      .expect(201);
    const body = res.body as CreatedKgResp;
    const adminToken = await jwtService.signAsync(
      {
        sub: body.user.id,
        role: 'admin',
        kindergarten_id: body.kindergarten.id,
        jti: randomUUID(),
      },
      { secret: jwtSecret, expiresIn: '1h' },
    );
    return {
      kgId: body.kindergarten.id,
      adminUserId: body.user.id,
      adminToken,
    };
  }

  async function seedUser(phone: string): Promise<string> {
    const id = randomUUID();
    await ctx.dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL app.bypass_rls = 'true'`);
      await m.query(
        `INSERT INTO users (id, phone, full_name) VALUES ($1, $2, 'WS Parent')`,
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
    await ctx.dataSource.transaction(async (m) => {
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
    const res = await request(ctx.server)
      .post('/api/v1/children')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(payload)
      .expect(201);
    return res.body.id as string;
  }

  /**
   * Wraps a socket.io-client connection in a one-shot promise that resolves
   * on the first `connected` event from the server, or rejects on
   * `connect_error` / timeout.
   */
  function awaitConnected(
    socket: ClientSocket,
    timeoutMs = 5000,
  ): Promise<{
    user_id: string;
    rooms: string[];
  }> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error('connected_timeout')),
        timeoutMs,
      );
      socket.once('connected', (data: { user_id: string; rooms: string[] }) => {
        clearTimeout(t);
        resolve(data);
      });
      socket.once('connect_error', (err: Error) => {
        clearTimeout(t);
        reject(err);
      });
    });
  }

  function awaitConnectError(
    socket: ClientSocket,
    timeoutMs = 5000,
  ): Promise<{ message: string } | Error> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error('connect_error_timeout')),
        timeoutMs,
      );
      // Server-side rejects post-handshake via custom `auth_error` event
      // (socket.io v4 reserves `connect_error` for middleware rejects only).
      socket.once('auth_error', (err: { message: string }) => {
        clearTimeout(t);
        resolve(err);
      });
      socket.once('connect_error', (err: Error) => {
        clearTimeout(t);
        resolve(err);
      });
      socket.once('disconnect', () => {
        clearTimeout(t);
        // If we disconnected without an auth_error, treat as rejected too.
        resolve(new Error('disconnected'));
      });
    });
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  beforeAll(async () => {
    ctx = await createTestApp({ withWebsockets: true });
    const config = ctx.app.get(ConfigService);
    jwtSecret = config.getOrThrow<string>('auth.jwtAccessSecret');
    jwtService = ctx.app.get(JwtService);

    // Bind to an ephemeral port so the suite can run alongside other e2e
    // suites without conflict.
    await ctx.app.listen(0);
    const addr = ctx.server.address();
    if (addr === null || typeof addr === 'string') {
      throw new Error('cannot resolve ephemeral port');
    }
    serverPort = addr.port;
    baseUrl = `http://127.0.0.1:${serverPort}`;
  });

  afterAll(async () => {
    await truncateAll(ctx.dataSource);
    await flushRedis(ctx.redis);
    await ctx.app.close();
  });

  beforeEach(async () => {
    await truncateAll(ctx.dataSource);
    await flushRedis(ctx.redis);
    ctx.sms.lastSent = null;
    ctx.sms.log.length = 0;
    await seedSuperAdmin();
    saAccess = await loginSuperAdmin();
  });

  // ── A. Happy path: parent connects, auto-subscribes, receives broadcast ──

  it('connects with handshake JWT, auto-subscribes to user + child rooms, and receives a broadcast (Scenario A)', async () => {
    const a = await createKgWithAdmin('ws-a', '+77011990001');
    const childId = await createChild(a.adminToken, {
      full_name: 'WS-Child-A',
      date_of_birth: '2022-01-10',
    });

    const parentUserId = await seedUser('+77011990011');
    await seedApprovedGuardian(childId, parentUserId, a.kgId);

    const parentJwt = await mintParentAccess({
      sub: parentUserId,
      kindergartenId: a.kgId,
    });

    const socket = ioClient(baseUrl, {
      path: '/ws',
      auth: { token: parentJwt },
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
    });

    try {
      const ack = await awaitConnected(socket);
      expect(ack.user_id).toBe(parentUserId);
      // Always-room + one approved guardian-child link.
      expect(ack.rooms).toEqual(
        expect.arrayContaining([`user:${parentUserId}`, `child:${childId}`]),
      );
      expect(ack.rooms.length).toBe(2);

      // Broadcast from the server to the child room and assert the client
      // receives it.
      const gateway = ctx.app.get(NotificationGateway);
      const messageReceived = new Promise<{ hello: string }>(
        (resolve, reject) => {
          const t = setTimeout(
            () => reject(new Error('broadcast_timeout')),
            5000,
          );
          socket.once('attendance.checkin', (payload: { hello: string }) => {
            clearTimeout(t);
            resolve(payload);
          });
        },
      );

      gateway.server
        .to(`child:${childId}`)
        .emit('attendance.checkin', { hello: 'world' });

      const payload = await messageReceived;
      expect(payload).toEqual({ hello: 'world' });
    } finally {
      socket.disconnect();
    }
  });

  // ── B. Missing token → connect_error + immediate disconnect ──────────────

  it('rejects connection with no token via connect_error (Scenario B)', async () => {
    const socket = ioClient(baseUrl, {
      path: '/ws',
      // No auth payload — gateway must reject.
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
    });
    try {
      const err = await awaitConnectError(socket);
      expect(err.message).toBeDefined();
    } finally {
      socket.disconnect();
    }
  });

  // ── C. Invalid token → connect_error + immediate disconnect ──────────────

  it('rejects connection with a forged token via connect_error (Scenario C)', async () => {
    const socket = ioClient(baseUrl, {
      path: '/ws',
      auth: { token: 'not.a.real.jwt' },
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
    });
    try {
      const err = await awaitConnectError(socket);
      expect(err.message).toBeDefined();
    } finally {
      socket.disconnect();
    }
  });

  // ── D. User with no children connects and only joins user:{id} ───────────

  it('connects users with no guardian links and joins only user:{id} (Scenario D)', async () => {
    const a = await createKgWithAdmin('ws-d', '+77011990004');
    const lonelyUserId = await seedUser('+77011990014');
    const jwt = await mintParentAccess({
      sub: lonelyUserId,
      kindergartenId: a.kgId,
    });

    const socket = ioClient(baseUrl, {
      path: '/ws',
      auth: { token: jwt },
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
    });
    try {
      const ack = await awaitConnected(socket);
      expect(ack.user_id).toBe(lonelyUserId);
      expect(ack.rooms).toEqual([`user:${lonelyUserId}`]);
    } finally {
      socket.disconnect();
    }
  });

  // ── E. JWT scoping: parent in kg_A who also has a guardian row in kg_B ──
  //
  //   Mixed-tenant accounts exist in this system. A user can be a parent in
  //   kg_A AND have an approved guardian row in kg_B at the same time (e.g.
  //   children moved between kindergartens, or a relative living in two
  //   cities). When the user connects with a kg_A-scoped parent JWT, they
  //   must NOT subscribe to kg_B's child-room — receiving those events
  //   would leak from a tenant the current handshake is not scoped to.

  it('parent JWT scoped to kg_A does not join child:{cid} rooms for guardian links in kg_B (Scenario E)', async () => {
    const a = await createKgWithAdmin('ws-e-a', '+77011990005');
    const b = await createKgWithAdmin('ws-e-b', '+77011990006');

    const childA = await createChild(a.adminToken, {
      full_name: 'WS-E-Child-A',
      date_of_birth: '2022-01-10',
    });
    const childB = await createChild(b.adminToken, {
      full_name: 'WS-E-Child-B',
      date_of_birth: '2022-01-10',
    });

    // Same user is an approved guardian in BOTH kgs (mixed-tenant account).
    const parentUserId = await seedUser('+77011990015');
    await seedApprovedGuardian(childA, parentUserId, a.kgId);
    await seedApprovedGuardian(childB, parentUserId, b.kgId);

    // Connect with a kg_A-scoped parent JWT.
    const parentJwtA = await mintParentAccess({
      sub: parentUserId,
      kindergartenId: a.kgId,
    });

    const socket = ioClient(baseUrl, {
      path: '/ws',
      auth: { token: parentJwtA },
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
    });
    try {
      const ack = await awaitConnected(socket);
      expect(ack.user_id).toBe(parentUserId);
      // Joins only the kg_A child room — kg_B leak prevented.
      expect(ack.rooms).toEqual(
        expect.arrayContaining([`user:${parentUserId}`, `child:${childA}`]),
      );
      expect(ack.rooms).not.toContain(`child:${childB}`);
      expect(ack.rooms.length).toBe(2);
    } finally {
      socket.disconnect();
    }
  });

  // ── F. F15 Layer B: socket survives until JTI is blocklisted, then dies ──
  //
  //   Verifies the logout → Redis pub/sub → WS disconnect path. The test
  //   bypasses the controller and writes directly to the blocklist port;
  //   this proves the listener wiring without depending on the auth
  //   refresh-token plumbing inside the e2e harness.

  it('F15: socket disconnects with auth_error when its JTI is blocklisted (Scenario F)', async () => {
    const a = await createKgWithAdmin('ws-f', '+77011990007');
    const lonelyUserId = await seedUser('+77011990017');
    const jti = randomUUID();
    const jwt = await jwtService.signAsync(
      {
        sub: lonelyUserId,
        role: 'parent',
        kindergarten_id: a.kgId,
        jti,
      },
      { secret: jwtSecret, expiresIn: '60s' },
    );
    const exp = Math.floor(Date.now() / 1000) + 60;

    const socket = ioClient(baseUrl, {
      path: '/ws',
      auth: { token: jwt },
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
    });
    try {
      const ack = await awaitConnected(socket);
      expect(ack.user_id).toBe(lonelyUserId);

      const revokedSeen = new Promise<{ message: string }>(
        (resolve, reject) => {
          const t = setTimeout(() => reject(new Error('revoke_timeout')), 5000);
          socket.once('auth_error', (msg: { message: string }) => {
            clearTimeout(t);
            resolve(msg);
          });
          socket.once('disconnect', () => {
            clearTimeout(t);
            resolve({ message: 'disconnected' });
          });
        },
      );

      // Drive blocklist directly — same code path the controller exercises.
      const blocklist = ctx.app.get(TokenBlocklistPort);
      await blocklist.blocklist(jti, exp);

      const msg = await revokedSeen;
      // Either the explicit auth_error (if it landed before disconnect)
      // OR the disconnect itself proves the socket got killed.
      expect(['session_revoked', 'disconnected']).toContain(msg.message);
    } finally {
      socket.disconnect();
    }
  });
});
