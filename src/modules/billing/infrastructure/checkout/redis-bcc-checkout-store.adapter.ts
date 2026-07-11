import { Inject, Injectable } from '@nestjs/common';
import { CryptoCipherPort } from '@/shared-kernel/application/ports/crypto-cipher.port';
import { RedisService } from '@/redis/redis.service';
import {
  BccCheckoutHandle,
  BccCheckoutSession,
  BccCheckoutStorePort,
} from './bcc-checkout-store.port';
import { randomBytes } from 'node:crypto';

const SESSION_PREFIX = 'bcc:checkout:session:';
const PAYMENT_PREFIX = 'bcc:checkout:payment:';
const DEFAULT_TTL_SECONDS = 900;

const CREATE_OR_REUSE_SCRIPT = `
local existing = redis.call('GET', KEYS[2])
if existing then
  if redis.call('EXISTS', ARGV[4] .. existing) == 1 then
    return existing
  end
  redis.call('DEL', KEYS[2])
end
local created = redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2])
if not created then
  return ''
end
redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[2])
return ARGV[3]
`;

const DELETE_REVERSE_IF_MATCHES_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

@Injectable()
export class RedisBccCheckoutStoreAdapter extends BccCheckoutStorePort {
  private readonly ttlSeconds: number;

  constructor(
    private readonly redis: RedisService,
    @Inject(CryptoCipherPort)
    private readonly cipher: CryptoCipherPort,
  ) {
    super();
    this.ttlSeconds = readCheckoutTtl(process.env.BCC_CHECKOUT_TTL_SECONDS);
  }

  async createOrReuse(session: BccCheckoutSession): Promise<BccCheckoutHandle> {
    assertSession(session);
    const reverseKey = paymentKey(session.kindergartenId, session.paymentId);

    for (let attempt = 0; attempt < 3; attempt++) {
      const token = randomBytes(32).toString('base64url');
      const encrypted = this.cipher.encryptString(JSON.stringify(session));
      const result = await this.redis.eval(
        CREATE_OR_REUSE_SCRIPT,
        2,
        sessionKey(token),
        reverseKey,
        encrypted,
        String(this.ttlSeconds),
        token,
        SESSION_PREFIX,
      );
      if (typeof result === 'string' && result.length > 0) {
        return { token: result, expiresInSeconds: this.ttlSeconds };
      }
    }
    throw new Error('bcc_checkout_token_generation_failed');
  }

  async findTokenByPayment(
    kindergartenId: string,
    paymentId: string,
  ): Promise<string | null> {
    const reverseKey = paymentKey(kindergartenId, paymentId);
    const token = await this.redis.get(reverseKey);
    if (!token) return null;
    if ((await this.redis.exists(sessionKey(token))) === 1) return token;

    await this.redis.eval(
      DELETE_REVERSE_IF_MATCHES_SCRIPT,
      1,
      reverseKey,
      token,
    );
    return null;
  }

  async consume(token: string): Promise<BccCheckoutSession | null> {
    if (!isCheckoutToken(token)) return null;
    const encrypted = await this.redis.getdel(sessionKey(token));
    if (!encrypted) return null;

    let session: BccCheckoutSession;
    try {
      session = JSON.parse(
        this.cipher.decryptString(encrypted),
      ) as BccCheckoutSession;
      assertSession(session);
    } catch {
      return null;
    }

    await this.redis.eval(
      DELETE_REVERSE_IF_MATCHES_SCRIPT,
      1,
      paymentKey(session.kindergartenId, session.paymentId),
      token,
    );
    return session;
  }
}

function sessionKey(token: string): string {
  return `${SESSION_PREFIX}${token}`;
}

function paymentKey(kindergartenId: string, paymentId: string): string {
  return `${PAYMENT_PREFIX}${kindergartenId}:${paymentId}`;
}

function readCheckoutTtl(raw: string | undefined): number {
  if (raw == null || raw.trim() === '') return DEFAULT_TTL_SECONDS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 60 || value > 1800) {
    throw new Error(
      'BCC_CHECKOUT_TTL_SECONDS must be an integer from 60 to 1800',
    );
  }
  return value;
}

function isCheckoutToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

function assertSession(
  value: BccCheckoutSession,
): asserts value is BccCheckoutSession {
  if (
    !value ||
    typeof value.paymentId !== 'string' ||
    typeof value.kindergartenId !== 'string' ||
    typeof value.order !== 'string' ||
    typeof value.gatewayUrl !== 'string' ||
    typeof value.billingPhone !== 'string' ||
    typeof value.billingAddress !== 'string' ||
    !value.formFields ||
    typeof value.formFields !== 'object'
  ) {
    throw new Error('bcc_checkout_session_invalid');
  }
}
