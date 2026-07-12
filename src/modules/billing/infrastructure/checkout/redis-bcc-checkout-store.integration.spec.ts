import { Redis } from 'ioredis';
import { CryptoCipherPort } from '@/shared-kernel/application/ports/crypto-cipher.port';
import { RedisService } from '@/redis/redis.service';
import { RedisBccCheckoutStoreAdapter } from './redis-bcc-checkout-store.adapter';

const describeIntegration =
  process.env.INTEGRATION_DB === '1' ? describe : describe.skip;

class TestCipher extends CryptoCipherPort {
  encrypt(value: Buffer): string {
    return value.toString('base64');
  }
  decrypt(value: string): Buffer {
    return Buffer.from(value, 'base64');
  }
  encryptString(value: string): string {
    return Buffer.from(value, 'utf8').toString('base64');
  }
  decryptString(value: string): string {
    return Buffer.from(value, 'base64').toString('utf8');
  }
}

describeIntegration('RedisBccCheckoutStoreAdapter integration', () => {
  let redis: Redis;
  let store: RedisBccCheckoutStoreAdapter;

  beforeAll(async () => {
    redis = new Redis({
      host: process.env.REDIS_HOST ?? '127.0.0.1',
      port: Number(process.env.REDIS_PORT ?? 6379),
      password: process.env.REDIS_PASSWORD || undefined,
      lazyConnect: false,
      maxRetriesPerRequest: 1,
    });
    store = new RedisBccCheckoutStoreAdapter(
      redis as unknown as RedisService,
      new TestCipher(),
    );
    await redis.ping();
  });

  afterAll(async () => {
    await redis.quit();
  });

  it('reuses a live token and consumes it exactly once', async () => {
    const suffix = `${Date.now()}-${Math.random()}`;
    const session = {
      paymentId: `payment-${suffix}`,
      kindergartenId: `kg-${suffix}`,
      order: '12345678901234567890',
      gatewayUrl: 'https://test3ds.bcc.kz:5445/cgi-bin/cgi_link',
      formFields: { ORDER: '12345678901234567890', TRTYPE: '1' },
      billingPhone: '+77011234567',
      billingAddress: 'Алматы',
    };

    const first = await store.createOrReuse(session);
    const second = await store.createOrReuse(session);
    expect(second.token).toBe(first.token);
    await expect(
      store.findTokenByPayment(session.kindergartenId, session.paymentId),
    ).resolves.toBe(first.token);
    await expect(store.consume(first.token)).resolves.toEqual(session);
    await expect(store.consume(first.token)).resolves.toBeNull();
    await expect(
      store.findTokenByPayment(session.kindergartenId, session.paymentId),
    ).resolves.toBeNull();
  });
});
