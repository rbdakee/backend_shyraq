import type { ConfigService } from '@nestjs/config';
import type { AllConfigType } from '@/config/config.type';
import { buildBccBackendUrl } from './bcc-url';

function config(origin: string): ConfigService<AllConfigType> {
  return {
    getOrThrow: (key: string) => {
      if (key === 'app.backendDomain') return origin;
      if (key === 'app.apiPrefix') return 'api';
      throw new Error(`unexpected config key: ${key}`);
    },
  } as unknown as ConfigService<AllConfigType>;
}

describe('buildBccBackendUrl', () => {
  it('keeps an explicit HTTPS port required by BCC', () => {
    expect(
      buildBccBackendUrl(
        config('https://api.example.test'),
        'payments/bcc/return',
      ),
    ).toBe('https://api.example.test:443/api/v1/payments/bcc/return');
  });

  it('rejects a non-HTTPS public origin', () => {
    expect(() =>
      buildBccBackendUrl(
        config('http://api.example.test'),
        'payments/bcc/return',
      ),
    ).toThrow('bcc_public_url_must_use_https');
  });

  it('allows loopback HTTP for local development', () => {
    expect(
      buildBccBackendUrl(
        config('http://localhost:3000'),
        'payments/bcc/return',
      ),
    ).toBe('http://localhost:3000/api/v1/payments/bcc/return');
  });
});
