export const RedisKeys = {
  otpLogin: (phone: string) => `otp:login:${phone}`,
  otpLocked: (phone: string) => `otp:locked:${phone}`,
  rateOtp: (phone: string) => `rate:otp:${phone}`,
  tokenBlocklist: (jti: string) => `token:blocklist:${jti}`,
  rateApi: (userId: string, group: string) => `rate:api:${userId}:${group}`,
} as const;

export const RedisTtl = {
  OTP_LOGIN: 300,
  OTP_LOCKED: 900,
  RATE_OTP: 3600,
  RATE_API_WINDOW: 60,
} as const;
