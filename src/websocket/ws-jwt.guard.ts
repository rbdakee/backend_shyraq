import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import type { Socket } from 'socket.io';
import { JwtTokenPort } from '@/modules/auth/jwt-token.port';
import { TokenBlocklistPort } from '@/modules/auth/token-blocklist.port';

/**
 * WsJwtGuard — NestJS `CanActivate` for `@SubscribeMessage` handlers (B9
 * does not register any, but the guard is in place for B11 / B17 follow-on
 * batches and to enable per-message re-validation when the access token may
 * have rotated mid-session).
 *
 * Connection-level auth lives in `NotificationGateway.handleConnection` —
 * NestJS guards do NOT run on the connect lifecycle, so the guard cannot
 * be the only line of defense.
 */
@Injectable()
export class WsJwtGuard implements CanActivate {
  private readonly logger = new Logger(WsJwtGuard.name);

  constructor(
    private readonly jwt: JwtTokenPort,
    private readonly blocklist: TokenBlocklistPort,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const client = ctx.switchToWs().getClient<Socket>();
    const auth = client.handshake.auth as Record<string, unknown> | undefined;
    const token = auth?.token;
    if (typeof token !== 'string' || token.length === 0) {
      throw new WsException('unauthorized');
    }
    try {
      const payload = await this.jwt.verifyAccessToken(token);
      if (payload.jti) {
        const revoked = await this.blocklist.isBlocked(payload.jti);
        if (revoked) {
          throw new WsException('unauthorized');
        }
      }
      client.data.userId = payload.sub;
      client.data.role = payload.role;
      client.data.kindergartenId = payload.kindergarten_id ?? null;
      return true;
    } catch (err) {
      if (err instanceof WsException) throw err;
      throw new WsException('unauthorized');
    }
  }
}
