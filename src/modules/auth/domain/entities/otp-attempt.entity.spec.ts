import { MAX_OTP_ATTEMPTS, OtpAttempt } from './otp-attempt.entity';

describe('OtpAttempt (domain)', () => {
  it('hydrates from raw Redis state', () => {
    const a = OtpAttempt.hydrate({
      phone: '+77000000001',
      code: '123456',
      attempts: 0,
    });
    expect(a.phone).toBe('+77000000001');
    expect(a.code).toBe('123456');
    expect(a.attempts).toBe(0);
  });

  it('rejects negative attempts as invariant violation', () => {
    expect(() =>
      OtpAttempt.hydrate({
        phone: '+77000000001',
        code: '123456',
        attempts: -1,
      }),
    ).toThrow();
  });

  it('matches() returns true for identical code, false otherwise', () => {
    const a = OtpAttempt.hydrate({ phone: '+7', code: '123456', attempts: 0 });
    expect(a.matches('123456')).toBe(true);
    expect(a.matches('000000')).toBe(false);
  });

  it('registerWrongAttempt() returns true on threshold crossing', () => {
    const a = OtpAttempt.hydrate({ phone: '+7', code: '123456', attempts: 0 });
    expect(a.registerWrongAttempt()).toBe(false); // 1
    expect(a.registerWrongAttempt()).toBe(false); // 2
    expect(a.registerWrongAttempt()).toBe(true); // 3 -> lockout
    expect(a.attempts).toBe(MAX_OTP_ATTEMPTS);
  });
});
