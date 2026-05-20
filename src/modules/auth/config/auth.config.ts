import { registerAs } from '@nestjs/config';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MinLength,
} from 'class-validator';
import validateConfig from '@/utils/validate-config';
import { AuthConfig, SmsProvider, WhatsAppConfig } from './auth-config.type';

const SMS_PROVIDERS: ReadonlyArray<SmsProvider> = ['mock', 'whatsapp'];

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

  @IsString()
  @IsOptional()
  @IsIn(SMS_PROVIDERS as unknown as string[])
  SMS_PROVIDER: SmsProvider;

  @IsString()
  @IsOptional()
  WHATSAPP_PHONE_NUMBER_ID: string;

  @IsString()
  @IsOptional()
  WHATSAPP_ACCESS_TOKEN: string;

  @IsString()
  @IsOptional()
  WHATSAPP_API_VERSION: string;

  @IsString()
  @IsOptional()
  WHATSAPP_BUSINESS_ACCOUNT_ID: string;

  @IsString()
  @IsOptional()
  WHATSAPP_DEV_RECIPIENT_OVERRIDE: string;
}

function buildWhatsAppConfig(provider: SmsProvider): WhatsAppConfig | null {
  if (provider !== 'whatsapp') {
    return null;
  }

  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN?.trim();
  if (!phoneNumberId || !accessToken) {
    throw new Error(
      'SMS_PROVIDER=whatsapp requires WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_ACCESS_TOKEN to be set',
    );
  }

  const rawOverride = process.env.WHATSAPP_DEV_RECIPIENT_OVERRIDE?.trim();
  let devRecipientOverride: string | null = null;
  if (rawOverride) {
    const digitsOnly = rawOverride.replace(/[^\d]/g, '');
    if (process.env.NODE_ENV === 'production') {
      // Ignored in production but we don't fail startup — make the operator
      // aware via a startup-time warning emitted from the adapter.
      devRecipientOverride = null;
    } else if (digitsOnly.length < 6) {
      throw new Error(
        'WHATSAPP_DEV_RECIPIENT_OVERRIDE must contain at least 6 digits',
      );
    } else {
      devRecipientOverride = digitsOnly;
    }
  }

  return {
    phoneNumberId,
    accessToken,
    apiVersion: process.env.WHATSAPP_API_VERSION?.trim() || 'v21.0',
    businessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID?.trim() || null,
    devRecipientOverride,
  };
}

export default registerAs<AuthConfig>('auth', () => {
  validateConfig(process.env, EnvironmentVariablesValidator);

  const smsProvider = (process.env.SMS_PROVIDER as SmsProvider) || 'mock';

  return {
    smsProvider,
    whatsapp: buildWhatsAppConfig(smsProvider),
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
