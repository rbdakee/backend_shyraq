import { ConfigService } from '@nestjs/config';
import { AllConfigType } from '@/config/config.type';
import { BcryptPasswordHasherAdapter } from './bcrypt-password-hasher.adapter';

function makeConfig(cost = 4): ConfigService<AllConfigType> {
  return {
    getOrThrow: ((key: string) =>
      key === 'auth.bcryptCost'
        ? cost
        : undefined) as ConfigService<AllConfigType>['getOrThrow'],
  } as unknown as ConfigService<AllConfigType>;
}

describe('BcryptPasswordHasherAdapter', () => {
  it('hash → compare returns true for matching plain', async () => {
    const adapter = new BcryptPasswordHasherAdapter(makeConfig(4));
    const hash = await adapter.hash('s3cret');
    expect(hash).toMatch(/^\$2[aby]\$04\$/);
    await expect(adapter.compare('s3cret', hash)).resolves.toBe(true);
  });

  it('compare returns false for wrong plain', async () => {
    const adapter = new BcryptPasswordHasherAdapter(makeConfig(4));
    const hash = await adapter.hash('s3cret');
    await expect(adapter.compare('wrong', hash)).resolves.toBe(false);
  });

  it('uses cost from config (cost=5)', async () => {
    const adapter = new BcryptPasswordHasherAdapter(makeConfig(5));
    const hash = await adapter.hash('x');
    expect(hash).toMatch(/^\$2[aby]\$05\$/);
  });
});
