import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { AllConfigType } from '@/config/config.type';
import { TokenBlocklistPort } from '@/modules/auth/token-blocklist.port';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import type { AuthenticatedRequest } from '../types/authenticated-request';
import type { JwtPayload } from '../types/jwt-payload';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly configService: ConfigService<AllConfigType>,
    private readonly reflector: Reflector,
    private readonly blocklist: TokenBlocklistPort,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic =
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
        ctx.getHandler(),
        ctx.getClass(),
      ]) ?? false;
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractToken(req);
    if (!token) {
      throw new UnauthorizedException('missing_bearer_token');
    }

    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token, {
        secret: this.configService.getOrThrow('auth.jwtAccessSecret', {
          infer: true,
        }),
      });
    } catch {
      throw new UnauthorizedException('invalid_token');
    }

    if (payload.jti) {
      const revoked = await this.blocklist.isBlocked(payload.jti);
      if (revoked) {
        throw new UnauthorizedException('token_revoked');
      }
    }

    req.user = payload;
    return true;
  }

  private extractToken(req: AuthenticatedRequest): string | null {
    const header = req.headers['authorization'];
    if (!header || typeof header !== 'string') return null;
    const [scheme, token] = header.split(' ');
    return scheme === 'Bearer' && token ? token : null;
  }
}
