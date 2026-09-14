import { registerAs } from '@nestjs/config';
import { IsIn, IsInt, IsOptional, IsString, MinLength } from 'class-validator';
import validateConfig from '@/utils/validate-config';
import {
  CctvConfig,
  Go2rtcConfig,
  MediaGatewayProvider,
} from './cctv-config.type';

const MEDIA_GATEWAYS: ReadonlyArray<MediaGatewayProvider> = ['mock', 'go2rtc'];

class EnvironmentVariablesValidator {
  @IsString()
  @IsOptional()
  @IsIn(MEDIA_GATEWAYS as unknown as string[])
  CCTV_MEDIA_GATEWAY: MediaGatewayProvider;

  @IsString()
  @IsOptional()
  CCTV_GO2RTC_URL: string;

  @IsString()
  @IsOptional()
  CCTV_GO2RTC_USERNAME: string;

  @IsString()
  @IsOptional()
  CCTV_GO2RTC_PASSWORD: string;

  @IsInt()
  @IsOptional()
  CCTV_GO2RTC_TIMEOUT_MS: number;

  @IsString()
  @IsOptional()
  CCTV_STREAM_PUBLIC_BASE: string;

  @IsString()
  @IsOptional()
  CCTV_CODEC_PROBE_CRON: string;

  @IsString()
  @IsOptional()
  @MinLength(32)
  CCTV_STREAM_SECRET: string;

  @IsInt()
  @IsOptional()
  CCTV_STREAM_TOKEN_TTL_SECONDS: number;
}

function buildGo2rtcConfig(
  provider: MediaGatewayProvider,
): Go2rtcConfig | null {
  if (provider !== 'go2rtc') {
    return null;
  }

  const baseUrl = process.env.CCTV_GO2RTC_URL?.trim();
  const password = process.env.CCTV_GO2RTC_PASSWORD?.trim();
  if (!baseUrl || !password) {
    throw new Error(
      'CCTV_MEDIA_GATEWAY=go2rtc requires CCTV_GO2RTC_URL and CCTV_GO2RTC_PASSWORD to be set',
    );
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    username: process.env.CCTV_GO2RTC_USERNAME?.trim() || 'admin',
    password,
    timeoutMs: Number(process.env.CCTV_GO2RTC_TIMEOUT_MS ?? 10_000),
  };
}

export default registerAs<CctvConfig>('cctv', () => {
  validateConfig(process.env, EnvironmentVariablesValidator);

  const mediaGateway =
    (process.env.CCTV_MEDIA_GATEWAY?.trim() as MediaGatewayProvider) || 'mock';
  const publicBase = process.env.CCTV_STREAM_PUBLIC_BASE?.trim();

  return {
    mediaGateway,
    go2rtc: buildGo2rtcConfig(mediaGateway),
    streamPublicBase: publicBase ? publicBase.replace(/\/+$/, '') : null,
    codecProbeEnabled:
      (process.env.CCTV_CODEC_PROBE_CRON?.trim().toLowerCase() ?? 'enabled') !==
      'disabled',
    streamTokenSecret: process.env.CCTV_STREAM_SECRET?.trim() || null,
    streamTokenTtlSeconds: Number(
      process.env.CCTV_STREAM_TOKEN_TTL_SECONDS ?? 3600,
    ),
  };
});
