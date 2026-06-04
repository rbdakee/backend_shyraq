import { Injectable } from '@nestjs/common';
import { RedisService } from '@/redis/redis.service';
import { CryptoCipherPort } from '@/shared-kernel/application/ports/crypto-cipher.port';
import {
  KaspiOnboardingState,
  KaspiOnboardingStorePort,
} from './kaspi-onboarding-store.port';

/** TTL for an in-flight onboarding blob (5 minutes — §2.25). */
const ONBOARDING_TTL_SEC = 300;

const keyFor = (processId: string): string => `kaspi:onboarding:${processId}`;

/**
 * Redis-backed in-flight onboarding store (B24 / K5).
 *
 * The whole `KaspiOnboardingState` JSON is encrypted with `CryptoCipherPort`
 * (AES-256-GCM) before being written, because it carries the per-tenant device
 * ECDSA private key for up to 5 minutes. The Redis value is therefore a single
 * opaque base64 blob — a Redis dump leaks nothing usable.
 */
@Injectable()
export class RedisKaspiOnboardingStoreAdapter extends KaspiOnboardingStorePort {
  constructor(
    private readonly redis: RedisService,
    private readonly cipher: CryptoCipherPort,
  ) {
    super();
  }

  async put(state: KaspiOnboardingState): Promise<void> {
    const blob = this.cipher.encryptString(JSON.stringify(state));
    await this.redis.set(
      keyFor(state.processId),
      blob,
      'EX',
      ONBOARDING_TTL_SEC,
    );
  }

  async get(processId: string): Promise<KaspiOnboardingState | null> {
    const blob = await this.redis.get(keyFor(processId));
    if (!blob) return null;
    const json = this.cipher.decryptString(blob);
    return JSON.parse(json) as KaspiOnboardingState;
  }

  async delete(processId: string): Promise<void> {
    await this.redis.del(keyFor(processId));
  }
}
