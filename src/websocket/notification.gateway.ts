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
 * Sanity cap for the per-socket auto-disconnect timer (Layer A of the F15
 * fix). Access tokens are issued with 15-minute TTL today, so a 24h cap is
 * already an order of magnitude over the realistic ceiling — but the cap
 * exists so a forged or future-dated `exp` cannot pin a socket open beyond
 * sanity. Beyond the cap, the next handshake (with a fresh JWT) gets a
 * fresh timer.
 */
const SOCKET_TTL_CAP_MS = 24 * 60 * 60 * 1000; // 24h

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
 * Long-lived session safety (F15 fix — three layers):
 *   - Layer A: per-socket setTimeout aligned to `payload.exp` proactively
 *     disconnects when the JWT would have expired. Without this, a 15-minute-
 *     stale socket stays in rooms until network drops.
 *   - Layer B: `WsBlocklistListenerService` listens on a Redis pub/sub
 *     channel populated by `RedisTokenBlocklistAdapter.blocklist()`. On a
 *     revocation event the gateway disconnects every matching-jti socket
 *     it owns. Logout / refresh / role-select all hit this path.
 *   - Layer C (broadcast-time re-check) intentionally skipped — A+B cover
 *     the threat model and per-event lookups would add latency on the hot
 *     path for a vanishingly small residual window.
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

  /**
   * jti → live sockets (this api process only). Used by the blocklist
   * listener to disconnect just the sockets attached to a revoked JWT
   * without scanning all `server.sockets.sockets`.
   */
  private readonly socketsByJti = new Map<string, Set<Socket>>();

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

      // Stash on socket for any future @SubscribeMessage handlers and for
      // the blocklist listener (jti) / Layer A timer (exp).
      client.data.userId = payload.sub;
      client.data.role = payload.role;
      client.data.kindergartenId = payload.kindergarten_id ?? null;
      client.data.jti = payload.jti ?? null;

      // Auto-subscribe is JWT-aware: the resolved room set must match
      // the JWT's `role` + `kindergarten_id` at handshake time. A user
      // who is also a guardian / mentor in OTHER kindergartens does
      // NOT receive those tenants' events while connected with a
      // single-kg-scoped JWT. Re-handshake required to switch context.
      const { rooms } = await this.autoSubscribe.subscribe(client, payload);

      // Layer A — schedule a proactive disconnect at payload.exp. Without
      // this, an idle socket would keep streaming until network drops or
      // the next per-message guard runs (B9 has no @SubscribeMessage
      // handlers, so per-message re-validation never fires).
      this.scheduleExpiryDisconnect(client, payload.exp);

      // Layer B — index this socket by its jti so the blocklist listener
      // can find it on revoke without scanning all sockets.
      if (payload.jti) {
        this.indexSocketByJti(client, payload.jti);
      }

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
    // socket.io leaves rooms automatically on disconnect. We still need to
    // clear the Layer A timer + drop the jti index entry so neither leaks.
    const timer = client.data?.expiryTimer as NodeJS.Timeout | undefined;
    if (timer) {
      clearTimeout(timer);
      client.data.expiryTimer = undefined;
    }
    const jti = client.data?.jti as string | null | undefined;
    if (jti) {
      this.unindexSocketByJti(client, jti);
    }
    this.logger.debug(
      `disconnected socket=${client.id} user=${client.data?.userId ?? '<anon>'}`,
    );
  }

  /**
   * Public read-only view of the jti index for the blocklist listener.
   * Returns a snapshot array so callers can iterate safely while
   * `disconnect(true)` mutates the underlying set via `handleDisconnect`.
   */
  getSocketsByJti(jti: string): Socket[] {
    const set = this.socketsByJti.get(jti);
    return set ? Array.from(set) : [];
  }

  /**
   * Layer B handler — call from the blocklist listener. Disconnects every
   * locally-owned socket whose handshake JWT had this jti, emitting an
   * `auth_error` with `session_revoked` first so the client knows why.
   * Returns the count of sockets actually disconnected for telemetry.
   */
  revokeJti(jti: string): number {
    const sockets = this.getSocketsByJti(jti);
    if (sockets.length === 0) return 0;
    for (const socket of sockets) {
      try {
        socket.emit('auth_error', { message: 'session_revoked' });
      } catch {
        // emit failure is non-fatal — still force the disconnect below.
      }
      socket.disconnect(true);
    }
    this.logger.log(
      `revoked jti=${jti} disconnected_sockets=${sockets.length}`,
    );
    return sockets.length;
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

  private scheduleExpiryDisconnect(
    client: Socket,
    expUnix: number | undefined,
  ): void {
    if (typeof expUnix !== 'number' || !Number.isFinite(expUnix)) {
      // No `exp` claim means a malformed JWT slipped through verify (which
      // shouldn't happen with HS256 issuance) — fail closed.
      this.logger.warn(`socket=${client.id} missing_exp_claim`);
      client.disconnect(true);
      return;
    }
    const msUntilExpiry = expUnix * 1000 - Date.now();
    // If the token is already expired or about to expire (sub-zero ms), drop
    // the socket immediately. verifyAccessToken should have caught this but
    // defense-in-depth.
    if (msUntilExpiry <= 0) {
      client.emit('auth_error', { message: 'token_expired' });
      client.disconnect(true);
      return;
    }
    const delay = Math.min(msUntilExpiry, SOCKET_TTL_CAP_MS);
    const timer = setTimeout(() => {
      // Socket may have already been disconnected by the blocklist listener
      // or a network drop; emit + disconnect are idempotent so this is safe.
      try {
        client.emit('auth_error', { message: 'token_expired' });
      } catch {
        // emit failure means socket is already gone — disconnect is a no-op.
      }
      client.disconnect(true);
    }, delay);
    // Allow node to exit even if timers are pending (test cleanup, graceful
    // shutdown). Without unref the e2e suite would hang on close.
    timer.unref?.();
    client.data.expiryTimer = timer;
  }

  private indexSocketByJti(client: Socket, jti: string): void {
    let set = this.socketsByJti.get(jti);
    if (!set) {
      set = new Set();
      this.socketsByJti.set(jti, set);
    }
    set.add(client);
  }

  private unindexSocketByJti(client: Socket, jti: string): void {
    const set = this.socketsByJti.get(jti);
    if (!set) return;
    set.delete(client);
    if (set.size === 0) {
      this.socketsByJti.delete(jti);
    }
  }
}
