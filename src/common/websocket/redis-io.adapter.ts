import type { INestApplicationContext } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';
import { AllConfigType } from '@/config/config.type';

/**
 * Socket.io adapter wired through `@socket.io/redis-adapter` so events
 * emitted from any process (api or worker) reach every connected client
 * regardless of which api process owns the socket.
 *
 * Lifecycle:
 *   1. `connectToRedis()` builds a `pub` + `sub` Redis client pair using the
 *      same `redis.host/port/password` config the OTP/blocklist adapters use.
 *      Two clients are required by the redis-adapter API — one for PUBLISH,
 *      one for SUBSCRIBE/PSUBSCRIBE (ioredis cannot multiplex pub-sub).
 *   2. `createIOServer` calls the parent `IoAdapter.createIOServer` to obtain
 *      a real socket.io `Server`, then `server.adapter(...)` swaps the
 *      default in-memory adapter for the redis-backed one.
 *
 * Kept under `src/common/websocket/` because it is HTTP/transport plumbing
 * shared across the gateway and any future ad-hoc namespaces.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor?: ReturnType<typeof createAdapter>;
  private pubClient?: Redis;
  private subClient?: Redis;

  constructor(private readonly app: INestApplicationContext) {
    super(app);
  }

  async connectToRedis(): Promise<void> {
    const config = this.app.get(ConfigService<AllConfigType>);
    const host = config.getOrThrow('redis.host', { infer: true });
    const port = config.getOrThrow('redis.port', { infer: true });
    const password = config.get('redis.password', { infer: true });

    this.pubClient = new Redis({
      host,
      port,
      password: password ? password : undefined,
      lazyConnect: false,
      maxRetriesPerRequest: null,
    });
    this.subClient = this.pubClient.duplicate();

    this.pubClient.on('error', (err) =>
      this.logger.error(`pub client error: ${err.message}`),
    );
    this.subClient.on('error', (err) =>
      this.logger.error(`sub client error: ${err.message}`),
    );

    // Wait for both clients to be ready before constructing the adapter so
    // any subsequent emit() does not race against a half-open subscriber.
    await Promise.all([
      waitForReady(this.pubClient),
      waitForReady(this.subClient),
    ]);

    this.adapterConstructor = createAdapter(this.pubClient, this.subClient);
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, options) as Server;
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }
    return server;
  }

  /**
   * Disconnect both Redis clients on shutdown so node can exit cleanly. The
   * api process triggers this from `app.close()` via a `closeAll` hook, but
   * worker processes (T6) call it directly when they own a publisher-only
   * Server.
   */
  async dispose(): Promise<void> {
    await this.pubClient?.quit().catch(() => this.pubClient?.disconnect());
    await this.subClient?.quit().catch(() => this.subClient?.disconnect());
  }
}

function waitForReady(client: Redis): Promise<void> {
  if (client.status === 'ready') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onReady = (): void => {
      client.off('error', onError);
      resolve();
    };
    const onError = (err: Error): void => {
      client.off('ready', onReady);
      reject(err);
    };
    client.once('ready', onReady);
    client.once('error', onError);
  });
}
