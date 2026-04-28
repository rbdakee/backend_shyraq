import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AllConfigType } from '@/config/config.type';
import {
  JsonwebtokenJwtAdapter,
  parseTtlToSeconds,
} from './jsonwebtoken-jwt.adapter';

function makeConfig(
  overrides: Partial<Record<string, string | number>> = {},
): ConfigService<AllConfigType> {
  const map: Record<string, string | number> = {
    'auth.jwtAccessSecret': 'test-secret-must-be-long-enough-1234',
    'auth.jwtAccessTtl': '15m',
    ...overrides,
  };
  return {
    getOrThrow: ((key: string) =>
      map[key]) as ConfigService<AllConfigType>['getOrThrow'],
  } as unknown as ConfigService<AllConfigType>;
}

describe('parseTtlToSeconds', () => {
  it('parses bare numeric seconds', () =>
    expect(parseTtlToSeconds('60')).toBe(60));
  it('parses seconds suffix', () => expect(parseTtlToSeconds('45s')).toBe(45));
  it('parses minutes', () => expect(parseTtlToSeconds('15m')).toBe(900));
  it('parses hours', () => expect(parseTtlToSeconds('2h')).toBe(7200));
  it('parses days', () => expect(parseTtlToSeconds('1d')).toBe(86400));
  it('throws on bad format', () =>
    expect(() => parseTtlToSeconds('15x')).toThrow());
});

describe('JsonwebtokenJwtAdapter', () => {
  const config = makeConfig();
  const jwt = new JwtService();
  const secret = 'test-secret-must-be-long-enough-1234';

  it('issueAccessToken returns JWT with expected claims + jti + TTL', async () => {
    const adapter = new JsonwebtokenJwtAdapter(jwt, config);
    const out = await adapter.issueAccessToken({ sub: 'u-1', role: 'parent' });
    expect(out.expiresIn).toBe(900);
    expect(out.jti).toMatch(/^[0-9a-f-]{36}$/);
    const decoded = jwt.verify(out.token, { secret });
    expect(decoded).toMatchObject({ sub: 'u-1', role: 'parent', jti: out.jti });
    expect(
      (decoded as Record<string, unknown>).pending_role_select,
    ).toBeUndefined();
  });

  it('includes pending_role_select and kindergarten_id when provided', async () => {
    const adapter = new JsonwebtokenJwtAdapter(jwt, config);
    const out = await adapter.issueAccessToken({
      sub: 'u-2',
      role: 'staff_multi_role',
      pending_role_select: true,
    });
    const decoded = jwt.verify(out.token, { secret });
    expect((decoded as Record<string, unknown>).pending_role_select).toBe(true);
    expect(
      (decoded as Record<string, unknown>).kindergarten_id,
    ).toBeUndefined();

    const out2 = await adapter.issueAccessToken({
      sub: 'u-3',
      role: 'admin',
      kindergarten_id: 'kg-1',
    });
    const decoded2 = jwt.verify(out2.token, { secret });
    expect((decoded2 as Record<string, unknown>).kindergarten_id).toBe('kg-1');
  });

  it('decodeWithoutVerify returns jti + exp for a valid token', async () => {
    const adapter = new JsonwebtokenJwtAdapter(jwt, config);
    const out = await adapter.issueAccessToken({ sub: 'u-x', role: 'parent' });
    const claims = adapter.decodeWithoutVerify(out.token);
    expect(claims?.jti).toBe(out.jti);
    expect(typeof claims?.exp).toBe('number');
  });

  it('decodeWithoutVerify returns null for garbage', () => {
    const adapter = new JsonwebtokenJwtAdapter(jwt, config);
    expect(adapter.decodeWithoutVerify('not-a-jwt')).toBeNull();
  });
});
