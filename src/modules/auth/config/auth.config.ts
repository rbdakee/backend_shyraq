import { registerAs } from '@nestjs/config';
import { IsInt, IsOptional, IsString, Max, MinLength } from 'class-validator';
import validateConfig from '@/utils/validate-config';
import { AuthConfig } from './auth-config.type';

class EnvironmentVariablesValidator {
  @IsString()
  @MinLength(16)
  AUTH_JWT_SECRET: string;

  @IsString()
  @IsOptional()
  AUTH_JWT_TOKEN_EXPIRES_IN: string;

  @IsInt()
  @IsOptional()
  REFRESH_TOKEN_TTL_DAYS: number;

  @IsInt()
  @IsOptional()
  @Max(15)
  BCRYPT_COST: number;

  @IsInt()
  @IsOptional()
  OTP_LENGTH: number;

  @IsInt()
  @IsOptional()
  OTP_TTL_SECONDS: number;

  @IsInt()
  @IsOptional()
  RATE_LIMIT_OTP_REQUEST_LIMIT: number;

  @IsInt()
  @IsOptional()
  RATE_LIMIT_OTP_REQUEST_WINDOW_SEC: number;

  @IsInt()
  @IsOptional()
  RATE_LIMIT_SUPER_ADMIN_LOGIN_LIMIT: number;

  @IsInt()
  @IsOptional()
  RATE_LIMIT_SUPER_ADMIN_LOGIN_WINDOW_SEC: number;

  @IsInt()
  @IsOptional()
  RATE_LIMIT_PARENT_LINK_LIMIT: number;

  @IsInt()
  @IsOptional()
  RATE_LIMIT_PARENT_LINK_WINDOW_SEC: number;

  @IsString()
  @IsOptional()
  OTP_TEST_PHONES: string;

  @IsString()
  @IsOptional()
  OTP_TEST_CODE: string;
}

export default registerAs<AuthConfig>('auth', () => {
  validateConfig(process.env, EnvironmentVariablesValidator);

  return {
    jwtAccessSecret: process.env.AUTH_JWT_SECRET as string,
    jwtAccessTtl: process.env.AUTH_JWT_TOKEN_EXPIRES_IN || '15m',
    refreshTokenTtlDays: process.env.REFRESH_TOKEN_TTL_DAYS
      ? parseInt(process.env.REFRESH_TOKEN_TTL_DAYS, 10)
      : 30,
    bcryptCost: process.env.BCRYPT_COST
      ? parseInt(process.env.BCRYPT_COST, 10)
      : 12,
    otpLength: process.env.OTP_LENGTH
      ? parseInt(process.env.OTP_LENGTH, 10)
      : 6,
    otpTtlSeconds: process.env.OTP_TTL_SECONDS
      ? parseInt(process.env.OTP_TTL_SECONDS, 10)
      : 300,
    rateLimitOtpRequestLimit: process.env.RATE_LIMIT_OTP_REQUEST_LIMIT
      ? parseInt(process.env.RATE_LIMIT_OTP_REQUEST_LIMIT, 10)
      : 5,
    rateLimitOtpRequestWindowSec: process.env.RATE_LIMIT_OTP_REQUEST_WINDOW_SEC
      ? parseInt(process.env.RATE_LIMIT_OTP_REQUEST_WINDOW_SEC, 10)
      : 3600,
    rateLimitSuperAdminLoginLimit: process.env
      .RATE_LIMIT_SUPER_ADMIN_LOGIN_LIMIT
      ? parseInt(process.env.RATE_LIMIT_SUPER_ADMIN_LOGIN_LIMIT, 10)
      : 10,
    rateLimitSuperAdminLoginWindowSec: process.env
      .RATE_LIMIT_SUPER_ADMIN_LOGIN_WINDOW_SEC
      ? parseInt(process.env.RATE_LIMIT_SUPER_ADMIN_LOGIN_WINDOW_SEC, 10)
      : 3600,
    rateLimitParentLinkLimit: process.env.RATE_LIMIT_PARENT_LINK_LIMIT
      ? parseInt(process.env.RATE_LIMIT_PARENT_LINK_LIMIT, 10)
      : 5,
    rateLimitParentLinkWindowSec: process.env.RATE_LIMIT_PARENT_LINK_WINDOW_SEC
      ? parseInt(process.env.RATE_LIMIT_PARENT_LINK_WINDOW_SEC, 10)
      : 3600,
    otpTestPhones: process.env.OTP_TEST_PHONES || '',
    otpTestCode: process.env.OTP_TEST_CODE || '000000',
  };
});
