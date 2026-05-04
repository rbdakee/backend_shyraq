import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { RedisService } from '@/redis/redis.service';
import { RedisKeys } from '@/redis/redis-keys';
import {
  TokenBlocklistEventsPort,
  TokenBlocklistPort,
} from '../../token-blocklist.port';

/**
 * Pub/sub channel used to fan out access-token revocations to any process
 * holding live WS sockets. Payload is the bare `jti` string.
 *
 * Both the writer (auth.service.ts → blocklist) and the reader
 * (NotificationGateway → WsBlocklistListenerService) live in the api
 * process, but multiple api replicas may be deployed — pub/sub naturally
 * fans out to each replica's local subscriber.
 */
export const TOKEN_BLOCKLIST_CHANNEL = 'token:blocklist:events';

/**
 * RedisTokenBlocklistAdapter — concrete `TokenBlocklistPort` backed by Redis.
 *
 * write side:
 *   - SET `token:blocklist:{jti}` with TTL = (exp - now) so the key auto-
 *     expires when the JWT itself expires. Min 1s for safety.
 *   - PUBLISH `token:blocklist:events {jti}` on the same Redis client. WS
 *     processes subscribe on a separate connection (subscriber-mode blocks
 *     normal commands), iterate locally-owned sockets, and disconnect any
 *     whose stored `client.data.jti === jti`.
 *
 * read side (events): a duplicated ioredis client put into subscriber mode.
 * One subscriber per api process; handlers are dispatched in-process to
 * any registered listener.
 */
@Injectable()
export class RedisTokenBlocklistAdapter
  extends TokenBlocklistPort
  implements TokenBlocklistEventsPort, OnModuleDestroy
{
  private readonly logger = new Logger(RedisTokenBlocklistAdapter.name);
  private subscriber: Redis | null = null;
  private readonly handlers = new Set<(jti: string) => void>();

  constructor(private readonly redis: RedisService) {
    super();
  }

  async isBlocked(jti: string): Promise<boolean> {
    const v = await this.redis.get(RedisKeys.tokenBlocklist(jti));
    return v !== null;
  }

  async blocklist(jti: string, expUnix: number): Promise<void> {
    const ttl = Math.max(1, expUnix - Math.floor(Date.now() / 1000));
    await this.redis.set(RedisKeys.tokenBlocklist(jti), '1', 'EX', ttl);
    // Fire-and-forget publish; subscribers may be down or absent (worker
    // process has none) — that's OK, the SET is the source of truth and
    // future handshakes will see `isBlocked=true`. Pub/sub is the
    // proactive disconnect signal for already-open sockets.
    try {
      await this.redis.publish(TOKEN_BLOCKLIST_CHANNEL, jti);
    } catch (err) {
      // PUBLISH failure must not break logout/refresh — log and move on.
      this.logger.warn(
        `blocklist_publish_failed jti=${jti}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Subscribe to blocklist events. Lazily creates a single duplicated
   * subscriber client on first call (ioredis cannot mix subscribe/normal
   * commands on one connection). Returns an unsubscribe handle.
   */
  async subscribe(handler: (jti: string) => void): Promise<() => void> {
    this.handlers.add(handler);
    if (!this.subscriber) {
      this.subscriber = this.redis.duplicate();
      this.subscriber.on('message', (channel, message) => {
        if (channel !== TOKEN_BLOCKLIST_CHANNEL) return;
        for (const h of this.handlers) {
          try {
            h(message);
          } catch (err) {
            this.logger.warn(
              `blocklist_handler_failed: ${(err as Error).message}`,
            );
          }
        }
      });
      this.subscriber.on('error', (err) =>
        this.logger.error(`blocklist_subscriber_error: ${err.message}`),
      );
      await this.subscriber.subscribe(TOKEN_BLOCKLIST_CHANNEL);
    }
    return () => {
      this.handlers.delete(handler);
    };
  }

  async onModuleDestroy(): Promise<void> {
    if (this.subscriber) {
      await this.subscriber.quit().catch(() => this.subscriber?.disconnect());
      this.subscriber = null;
    }
    this.handlers.clear();
  }
}
