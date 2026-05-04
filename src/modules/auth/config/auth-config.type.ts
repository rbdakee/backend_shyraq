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
  rateLimitParentLinkLimit: number;
  rateLimitParentLinkWindowSec: number;
  otpTestPhones: string;
  otpTestCode: string;
};
