import { createHmac, timingSafeEqual } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AllConfigType } from '@/config/config.type';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';

export interface StreamTokenClaims {
  cameraId: string;
  userId: string;
  /** Unix seconds. */
  expiresAt: number;
}

export interface MintedStreamToken {
  token: string;
  expiresAt: Date;
}

const VERSION = 'v1';

/**
 * Signs and verifies the tokens that ride in stream URLs.
 *
 * Self-verifying HMAC rather than a Redis lookup, because HLS is chatty: each
 * viewer polls a playlist about once a second and pulls two segments in the
 * same time, and every one of those requests has to be authorised. At a
 * hundred parents that is a few hundred authorisations a second — fine for a
 * signature check, wasteful as a round trip to Redis.
 *
 * The cost of that choice is revocation: a token stays valid until it expires
 * even if the guardian's `view_cctv` is turned off a minute later. The TTL is
 * the bound on that window (default one hour, `CCTV_STREAM_TOKEN_TTL_SECONDS`).
 * If instant revocation is ever needed, add a Redis denylist keyed by camera
 * or user — the check stays O(1) and only fires for tokens that are otherwise
 * valid.
 */
@Injectable()
export class CctvStreamTokenService {
  constructor(
    private readonly config: ConfigService<AllConfigType>,
    @Inject(ClockPort) private readonly clock: ClockPort,
  ) {}

  /** False when no signing key is configured — streaming is then disabled. */
  get isConfigured(): boolean {
    return this.secretOrNull() !== null;
  }

  mint(cameraId: string, userId: string): MintedStreamToken {
    const secret = this.requireSecret();
    const ttl = this.config.getOrThrow('cctv.streamTokenTtlSeconds', {
      infer: true,
    });
    const expiresAt = Math.floor(this.clock.now().getTime() / 1000) + ttl;
    const payload = this.payload({ cameraId, userId, expiresAt });
    return {
      token: `${payload}.${this.sign(payload, secret)}`,
      expiresAt: new Date(expiresAt * 1000),
    };
  }

  /**
   * Returns the claims when the token is intact and unexpired, null otherwise.
   * Callers treat null as 403 — never as a reason to explain *why*, since the
   * only consumer of a rejection is an attacker.
   */
  verify(token: string | undefined | null): StreamTokenClaims | null {
    const secret = this.secretOrNull();
    if (!secret || !token) return null;

    const lastDot = token.lastIndexOf('.');
    if (lastDot <= 0) return null;
    const payload = token.slice(0, lastDot);
    const signature = token.slice(lastDot + 1);

    const expected = this.sign(payload, secret);
    if (!constantTimeEquals(signature, expected)) return null;

    const [version, cameraId, userId, expRaw] = payload.split('.');
    if (version !== VERSION || !cameraId || !userId || !expRaw) return null;

    const expiresAt = Number(expRaw);
    if (!Number.isFinite(expiresAt)) return null;
    if (expiresAt * 1000 <= this.clock.now().getTime()) return null;

    return { cameraId, userId, expiresAt };
  }

  private payload(claims: StreamTokenClaims): string {
    return `${VERSION}.${claims.cameraId}.${claims.userId}.${claims.expiresAt}`;
  }

  private sign(payload: string, secret: string): string {
    return createHmac('sha256', secret).update(payload).digest('base64url');
  }

  private requireSecret(): string {
    const secret = this.secretOrNull();
    if (!secret) {
      throw new Error('cctv_stream_secret_missing');
    }
    return secret;
  }

  private secretOrNull(): string | null {
    return this.config.get('cctv.streamTokenSecret', { infer: true }) ?? null;
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on length mismatch, which would itself leak length
  // through the exception path — compare lengths first and bail uniformly.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
