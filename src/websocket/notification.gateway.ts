import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { JwtTokenPort } from '@/modules/auth/jwt-token.port';
import { TokenBlocklistPort } from '@/modules/auth/token-blocklist.port';
import { WsAutoSubscribeService } from './ws-auto-subscribe.service';

/**
 * NotificationGateway — single socket.io endpoint mounted at `/ws`.
 *
 * Authentication contract:
 *   - JWT travels in `socket.handshake.auth.token` (socket.io v4 standard).
 *     Query-string transport is NOT supported — query gets logged in access
 *     logs and our standard observability stack.
 *   - `handleConnection` runs on every successful socket.io handshake. Any
 *     decode/verify failure → emit `connect_error` with a generic
 *     `unauthorized` message (no leakage of which check failed) and force
 *     disconnect. NestJS @UseGuards on @SubscribeMessage do NOT cover the
 *     connect step — guarding lifecycle here is mandatory.
 *
 * After auth succeeds, `WsAutoSubscribeService` joins the socket to the
 * full set of rooms it should receive (per `endpoints.md §0.6`) and the
 * gateway emits a `connected` event with the resolved room list so clients
 * can confirm subscription before they consider themselves "online".
 *
 * `@SubscribeMessage` handlers are intentionally absent — B9 ships the
 * auto-subscribe-only model. Future batches may add `subscribe` /
 * `unsubscribe` for ad-hoc rooms (B17 stories scoped to a single child, etc).
 */
@WebSocketGateway({
  path: '/ws',
  // Mirrors the HTTP CORS open in src/main.ts (NestFactory.create cors:true).
  cors: { origin: true, credentials: true },
  transports: ['websocket'],
})
export class NotificationGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(NotificationGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwtTokenPort: JwtTokenPort,
    private readonly tokenBlocklist: TokenBlocklistPort,
    private readonly autoSubscribe: WsAutoSubscribeService,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    try {
      const token = this.extractToken(client);
      if (!token) {
        return this.rejectAndDisconnect(client, 'missing_token');
      }
      let payload;
      try {
        payload = await this.jwtTokenPort.verifyAccessToken(token);
      } catch {
        return this.rejectAndDisconnect(client, 'invalid_token');
      }
      if (payload.jti) {
        const revoked = await this.tokenBlocklist.isBlocked(payload.jti);
        if (revoked) {
          return this.rejectAndDisconnect(client, 'token_revoked');
        }
      }

      // Stash on socket for any future @SubscribeMessage handlers.
      client.data.userId = payload.sub;
      client.data.role = payload.role;
      client.data.kindergartenId = payload.kindergarten_id ?? null;

      const { rooms } = await this.autoSubscribe.subscribe(client, payload.sub);
      client.emit('connected', { user_id: payload.sub, rooms });

      this.logger.log(
        `connected socket=${client.id} user=${payload.sub} rooms=${rooms.length}`,
      );
    } catch (err) {
      // Last-resort catch — auto-subscribe DB lookup blew up, etc. Don't leak
      // the error message. Audit log gets the redacted detail.
      const reason = err instanceof Error ? err.message : 'unknown';
      this.logger.error(`handleConnection failed: ${reason}`);
      return this.rejectAndDisconnect(client, 'internal_error');
    }
  }

  handleDisconnect(client: Socket): void {
    // socket.io leaves rooms automatically on disconnect.
    this.logger.debug(
      `disconnected socket=${client.id} user=${client.data?.userId ?? '<anon>'}`,
    );
  }

  /**
   * Extracts the JWT from `handshake.auth.token` only. Query-string is
   * intentionally ignored.
   */
  private extractToken(client: Socket): string | null {
    const auth = client.handshake.auth as Record<string, unknown> | undefined;
    const token = auth?.token;
    return typeof token === 'string' && token.length > 0 ? token : null;
  }

  private rejectAndDisconnect(client: Socket, reasonTag: string): void {
    // Generic message to client; reason tag stays server-side only.
    // Note: `connect_error` is reserved in socket.io v4 — server-side emits
    // are blocked. Use a custom `auth_error` event instead; clients should
    // listen on both `auth_error` (post-handshake reject) and `connect_error`
    // (middleware reject — not used here but kept for forward compatibility).
    this.logger.warn(`auth_rejected socket=${client.id} reason=${reasonTag}`);
    client.emit('auth_error', { message: 'unauthorized' });
    client.disconnect(true);
  }
}
