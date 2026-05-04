import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { TokenBlocklistEventsPort } from '@/modules/auth/token-blocklist.port';
import { NotificationGateway } from './notification.gateway';

/**
 * WsBlocklistListenerService — Layer B of the F15 fix.
 *
 * On boot, subscribes to the Redis blocklist pub/sub channel exposed by
 * `TokenBlocklistEventsPort`. Each published `jti` triggers
 * `NotificationGateway.revokeJti(jti)` which emits `auth_error` with
 * `session_revoked` and force-disconnects every locally-owned socket
 * carrying that jti.
 *
 * Multi-process semantics: every api process subscribes independently and
 * only acts on sockets it owns locally. Redis pub/sub fans the message
 * out to all replicas, so `auth.service.ts` calling `blocklist.blocklist()`
 * once is enough to kick the user from every replica.
 *
 * The worker process must NOT instantiate this service — it has no
 * sockets and no `NotificationGateway`. Wired only inside `WebsocketModule`.
 */
@Injectable()
export class WsBlocklistListenerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(WsBlocklistListenerService.name);
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly events: TokenBlocklistEventsPort,
    private readonly gateway: NotificationGateway,
  ) {}

  async onModuleInit(): Promise<void> {
    this.unsubscribe = await this.events.subscribe((jti) => {
      this.handleRevocation(jti);
    });
    this.logger.log('blocklist_listener_subscribed');
  }

  /**
   * Public so unit tests can drive the handler without spinning up Redis.
   */
  handleRevocation(jti: string): void {
    if (!jti || typeof jti !== 'string') {
      this.logger.warn(`blocklist_event_ignored payload=${typeof jti}`);
      return;
    }
    try {
      const count = this.gateway.revokeJti(jti);
      // Routinely zero on the api process that didn't own the socket
      // (other replica) — debug-level only.
      if (count === 0) {
        this.logger.debug(`blocklist_event jti=${jti} disconnected=0`);
      }
    } catch (err) {
      this.logger.error(
        `blocklist_event_failed jti=${jti}: ${(err as Error).message}`,
      );
    }
  }

  onModuleDestroy(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }
}
