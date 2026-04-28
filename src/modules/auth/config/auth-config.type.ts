export type AuthConfig = {
  jwtAccessSecret: string;
  jwtAccessTtl: string;
  refreshTokenTtlDays: number;
  bcryptCost: number;
  otpLength: number;
  otpTtlSeconds: number;
  rateLimitOtpRequestLimit: number;
  rateLimitOtpRequestWindowSec: number;
  rateLimitSuperAdminLoginLimit: number;
  rateLimitSuperAdminLoginWindowSec: number;
  otpTestPhones: string;
  otpTestCode: string;
};
