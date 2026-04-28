import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { AllConfigType } from '@/config/config.type';
import {
  DecodedAccessClaims,
  IssueAccessPayload,
  IssueAccessResult,
  JwtTokenPort,
} from '../../jwt-token.port';

const TTL_PATTERN = /^(\d+)([smhd])$/;
const NUMERIC_PATTERN = /^\d+$/;

@Injectable()
export class JsonwebtokenJwtAdapter extends JwtTokenPort {
  constructor(
    private readonly jwt: JwtService,
    private readonly configService: ConfigService<AllConfigType>,
  ) {
    super();
  }

  async issueAccessToken(
    payload: IssueAccessPayload,
  ): Promise<IssueAccessResult> {
    const jti = randomUUID();
    const expiresIn = parseTtlToSeconds(
      this.configService.getOrThrow('auth.jwtAccessTtl', { infer: true }),
    );
    const claims: Record<string, unknown> = {
      sub: payload.sub,
      role: payload.role,
      jti,
    };
    if (payload.kindergarten_id)
      claims.kindergarten_id = payload.kindergarten_id;
    if (payload.pending_role_select === true) claims.pending_role_select = true;

    const token = await this.jwt.signAsync(claims, {
      secret: this.configService.getOrThrow('auth.jwtAccessSecret', {
        infer: true,
      }),
      expiresIn,
    });
    return { token, jti, expiresIn };
  }

  decodeWithoutVerify(token: string): DecodedAccessClaims | null {
    const decoded: unknown = this.jwt.decode(token);
    if (decoded === null || typeof decoded !== 'object') return null;
    const obj = decoded as Record<string, unknown>;
    const out: DecodedAccessClaims = {};
    if (typeof obj.jti === 'string') out.jti = obj.jti;
    if (typeof obj.exp === 'number') out.exp = obj.exp;
    return out;
  }
}

export function parseTtlToSeconds(ttl: string): number {
  if (NUMERIC_PATTERN.test(ttl)) return Number(ttl);
  const match = TTL_PATTERN.exec(ttl);
  if (!match) throw new Error(`Invalid TTL format: ${ttl}`);
  const value = Number(match[1]);
  const unit = match[2];
  switch (unit) {
    case 's':
      return value;
    case 'm':
      return value * 60;
    case 'h':
      return value * 3600;
    case 'd':
      return value * 86400;
    default:
      throw new Error(`Invalid TTL unit: ${unit}`);
  }
}
