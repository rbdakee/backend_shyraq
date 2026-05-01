import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import { Server } from 'socket.io';
import { AllConfigType } from '@/config/config.type';
import { SocketIoServerProvider } from '@/websocket/socket-io-server.provider';

/**
 * Worker-process implementation of `SocketIoServerProvider`.
 *
 * The worker owns a *publisher-only* `socket.io` Server: it never accepts
 * an HTTP upgrade because no `httpServer` is passed to the constructor, but
 * once `server.adapter(...)` attaches the redis-adapter every
 * `server.to(room).emit(...)` call publishes the event over Redis pub/sub
 * to api processes that hold real client sockets in `room`.
 *
 * Why a Server with no listener instead of just publishing to Redis
 * directly: socket.io's redis-adapter wire format includes ack-tracking,
 * binary-attachment indices, and namespace routing that we'd otherwise
 * have to reimplement. Spinning up an idle `Server` is cheap (no HTTP
 * binding, no event listeners attached) and lets the worker piggy-back on
 * the official protocol.
 *
 * Lifecycle:
 *   - `onModuleInit` builds two ioredis clients (`pub` + `sub`) and a
 *     `socket.io` Server, then attaches the redis-adapter.
 *   - `onModuleDestroy` closes the Server and disconnects both clients so
 *     the worker process exits cleanly on SIGTERM/SIGINT.
 */
@Injectable()
export class WorkerSocketIoServerProvider
  extends SocketIoServerProvider
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(WorkerSocketIoServerProvider.name);
  private server?: Server;
  private pubClient?: Redis;
  private subClient?: Redis;

  constructor(private readonly config: ConfigService<AllConfigType>) {
    super();
  }

  async onModuleInit(): Promise<void> {
    const host = this.config.getOrThrow('redis.host', { infer: true });
    const port = this.config.getOrThrow('redis.port', { infer: true });
    const password = this.config.get('redis.password', { infer: true });

    this.pubClient = new Redis({
      host,
      port,
      password: password ? password : undefined,
      lazyConnect: false,
      maxRetriesPerRequest: null,
    });
    this.subClient = this.pubClient.duplicate();

    this.pubClient.on('error', (err) =>
      this.logger.error(`worker pub client error: ${err.message}`),
    );
    this.subClient.on('error', (err) =>
      this.logger.error(`worker sub client error: ${err.message}`),
    );

    await Promise.all([
      waitForReady(this.pubClient),
      waitForReady(this.subClient),
    ]);

    // Standalone Server — no httpServer argument, no listener bound. The
    // adapter takes over fan-out, so emit(...) calls from inside the worker
    // publish onto Redis instead of writing to local sockets.
    this.server = new Server();
    this.server.adapter(createAdapter(this.pubClient, this.subClient));
    this.logger.log('worker socket.io publisher attached to Redis adapter');
  }

  getServer(): Server | undefined {
    return this.server;
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.server?.close();
    } catch (err) {
      this.logger.warn(
        `worker socket.io close failed: ${(err as Error).message}`,
      );
    }
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
