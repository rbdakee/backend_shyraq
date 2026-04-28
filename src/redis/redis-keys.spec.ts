import { RedisKeys, RedisTtl } from './redis-keys';

describe('RedisKeys', () => {
  it('builds login OTP key', () => {
    expect(RedisKeys.otpLogin('+77000000001')).toBe('otp:login:+77000000001');
  });

  it('builds token blocklist key', () => {
    expect(RedisKeys.tokenBlocklist('abc123')).toBe('token:blocklist:abc123');
  });

  it('builds per-user rate-limit key', () => {
    expect(RedisKeys.rateApi('user-1', 'auth:otp')).toBe(
      'rate:api:user-1:auth:otp',
    );
  });

  it('exposes expected TTLs in seconds', () => {
    expect(RedisTtl.OTP_LOGIN).toBe(300);
    expect(RedisTtl.OTP_LOCKED).toBe(900);
    expect(RedisTtl.RATE_OTP).toBe(3600);
    expect(RedisTtl.RATE_API_WINDOW).toBe(60);
  });
});
